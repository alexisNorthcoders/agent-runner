import { open, readdir, realpath as fsRealpath, stat } from 'fs/promises';
import { basename, join } from 'path';
import { applyTranscriptLines, emptyTranscript, listClaudeCwds, subagentCount } from './agentBackend/claudeTranscripts.js';
import { errorMessageFromUnknown } from './issuePipeline/index.js';
import { canonicalPath, workspaceOfPaths } from './workspaceInference.js';

/**
 * The session watch: which interactive agent sessions are open on this machine, which workspace
 * each is in, and whether the agent is working or waiting for the owner, for the office and
 * `claude:status`. It reads the transcripts the agent already writes (the Claude-specific parsing
 * is in src/agentBackend/claudeTranscripts.js), so a session pays no tokens and no latency.
 *
 * Every `intervalMs` it `stat`s every transcript but opens only those written in the last
 * `activeMs`, and reads only the bytes appended since the last poll (a file seen for the first time
 * from its tail). A session is open while its transcript is that recent; running agent processes
 * (`/proc`, best effort) only cap the sessions counted per cwd. Prompts and replies are never kept.
 *
 * @typedef {{
 *   id: string,
 *   workspaceAlias: string | null,
 *   cwd: string,
 *   branch: string | null,
 *   state: 'working' | 'waiting',
 *   activity: string | null,
 *   subagents: number,
 *   since: string,
 *   lastEntryAt: string,
 * }} OfficeSession
 *   `since`: when the watch first saw it open. `lastEntryAt`: its latest transcript entry.
 *
 * @typedef {{ path: string, size: number, mtimeMs: number }} TranscriptFile
 *
 * @typedef {{
 *   list: (root: string) => Promise<TranscriptFile[]>,
 *   read: (path: string, start: number, end: number) => Promise<Buffer>,
 * }} TranscriptFs
 *   `list`: every `<root>/<folder>/<id>.jsonl` with its size and mtime. `read`: the bytes `[start, end)`.
 */

export const SESSION_POLL_MS = 3000;
export const SESSION_ACTIVE_MS = 10 * 60_000;
/** A file seen for the first time, or one that grew by more than MAX_READ_BYTES in a poll, is read from its last TAIL_BYTES. */
export const TAIL_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 1024 * 1024;

/** @returns {TranscriptFs} */
export function nodeTranscriptFs() {
  return {
    async list(root) {
      const files = [];
      for (const dir of await readdir(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        let names;
        try {
          names = await readdir(join(root, dir.name));
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const path = join(root, dir.name, name);
          try {
            const st = await stat(path);
            if (st.isFile()) files.push({ path, size: st.size, mtimeMs: st.mtimeMs });
          } catch {
            /* removed since the listing */
          }
        }
      }
      return files;
    },
    async read(path, start, end) {
      const fh = await open(path, 'r');
      try {
        const buf = Buffer.alloc(Math.max(0, end - start));
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}

/**
 * @typedef {{
 *   offset: number,
 *   partial: Buffer,
 *   transcript: import('./agentBackend/claudeTranscripts.js').TranscriptState,
 *   openSince: number | null,
 * }} Tracked
 *   Per transcript file: how far it's been read, the unfinished last line, what it says so far,
 *   and when it first counted as an open session.
 */

/**
 * @param {{
 *   root: string,
 *   workspaces: { list: () => Promise<Array<{ alias: string, root: string }>> },
 *   claudeCwds?: () => Promise<string[]>,
 *   fs?: TranscriptFs,
 *   realpath?: (p: string) => Promise<string>,
 *   intervalMs?: number,
 *   activeMs?: number,
 *   now?: () => number,
 *   onChange?: import('./stateChanges.js').NotifyChange,
 *   logger?: Pick<Console, 'info' | 'warn'>,
 * }} deps
 *   `claudeCwds`: the cwd of each running agent process (`/proc`), injected so tests can fake it.
 */
export function createSessionWatch({
  root,
  workspaces,
  claudeCwds = () => listClaudeCwds(),
  fs = nodeTranscriptFs(),
  realpath = fsRealpath,
  intervalMs = SESSION_POLL_MS,
  activeMs = SESSION_ACTIVE_MS,
  now = Date.now,
  onChange = () => {},
  logger = console,
}) {
  /** @type {Map<string, Tracked>} */
  const tracked = new Map();
  /** @type {OfficeSession[]} */
  let sessions = [];
  let signature = '[]';
  let warned = false;
  let polling = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** Read what `file` gained since the last poll into `t`. @param {TranscriptFile} file @param {Tracked | undefined} t @returns {Promise<Tracked>} */
  async function catchUp(file, t) {
    let cur = t;
    // gone below the offset: truncated or replaced, so start again from the beginning
    if (cur && file.size < cur.offset) cur = undefined;
    const fresh = !cur;
    const tracking = cur ?? { offset: 0, partial: Buffer.alloc(0), transcript: emptyTranscript(), openSince: null };
    let start = tracking.offset;
    let skipFirst = false;
    if (fresh ? file.size > TAIL_BYTES : file.size - start > MAX_READ_BYTES) {
      start = file.size - TAIL_BYTES;
      skipFirst = true;
      tracking.partial = Buffer.alloc(0);
    }
    if (file.size <= start) {
      tracking.offset = file.size;
      return tracking;
    }
    let buf = Buffer.concat([tracking.partial, await fs.read(file.path, start, file.size)]);
    tracking.offset = file.size;
    if (skipFirst) {
      // the read starts mid-line (maybe): drop up to the first line break
      const nl = buf.indexOf(0x0a);
      buf = nl < 0 ? Buffer.alloc(0) : buf.subarray(nl + 1);
    }
    const end = buf.lastIndexOf(0x0a);
    tracking.partial = end < 0 ? buf : buf.subarray(end + 1);
    if (end >= 0) applyTranscriptLines(tracking.transcript, buf.subarray(0, end).toString('utf8').split('\n'));
    return tracking;
  }

  /** @param {string[]} cwds @returns {Promise<Map<string, number>>} the agent processes running in each (canonical) cwd */
  async function processesByCwd(cwds) {
    /** @type {Map<string, number>} */
    const out = new Map();
    for (const c of cwds) {
      const canon = await canonicalPath(c, realpath);
      out.set(canon, (out.get(canon) ?? 0) + 1);
    }
    return out;
  }

  /** @returns {Promise<OfficeSession[]>} */
  async function scan() {
    const t = now();
    const files = (await fs.list(root)).filter((f) => t - f.mtimeMs <= activeMs);
    const live = new Set(files.map((f) => f.path));
    for (const p of tracked.keys()) if (!live.has(p)) tracked.delete(p);
    /** @type {Array<{ file: TranscriptFile, tr: Tracked }>} */
    const read = [];
    for (const file of files) {
      try {
        const tr = await catchUp(file, tracked.get(file.path));
        tracked.set(file.path, tr);
        read.push({ file, tr });
      } catch (err) {
        // a transcript that can't be read now (removed, permissions) is tried again next poll
        tracked.delete(file.path);
        logger.warn(`session watch: ${basename(file.path)}: ${errorMessageFromUnknown(err)}`);
      }
    }
    const interactive = read.filter(({ tr }) => tr.transcript.interactive === true && tr.transcript.state && tr.transcript.cwd);
    /** @type {Map<string, number>} */
    let procs;
    let roots;
    if (interactive.length) {
      // best effort: /proc can be unavailable or name the process differently, which hides nothing
      procs = await processesByCwd(await claudeCwds().catch(() => []));
      roots = await workspaces.list().catch(() => []);
    } else {
      procs = new Map();
      roots = [];
    }
    /** @type {Map<string, typeof interactive>} */
    const byCwd = new Map();
    for (const s of interactive) {
      const cwd = await canonicalPath(/** @type {string} */ (s.tr.transcript.cwd), realpath);
      byCwd.set(cwd, [...(byCwd.get(cwd) ?? []), s]);
    }
    /** @type {OfficeSession[]} */
    const open = [];
    const openPaths = new Set();
    for (const [cwd, group] of byCwd) {
      // with agent processes found in the directory, one session each (the most recently written); with none found, all
      const keep = group.sort((a, b) => (b.tr.transcript.lastEntryAt ?? b.file.mtimeMs) - (a.tr.transcript.lastEntryAt ?? a.file.mtimeMs)).slice(0, procs.get(cwd) || group.length);
      for (const { file, tr } of keep) {
        const x = tr.transcript;
        tr.openSince ??= t;
        openPaths.add(file.path);
        open.push({
          id: x.sessionId ?? basename(file.path, '.jsonl'),
          workspaceAlias: await workspaceOfPaths([cwd], roots, realpath),
          cwd: /** @type {string} */ (x.cwd),
          branch: x.branch,
          state: /** @type {'working' | 'waiting'} */ (x.state),
          activity: x.activity,
          subagents: subagentCount(x, t),
          since: new Date(tr.openSince).toISOString(),
          lastEntryAt: new Date(x.lastEntryAt ?? file.mtimeMs).toISOString(),
        });
      }
    }
    for (const [p, tr] of tracked) if (!openPaths.has(p)) tr.openSince = null;
    return open.sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
  }

  /** One poll. Never throws: a failing poll leaves no sessions. */
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      sessions = await scan();
      warned = false;
    } catch (err) {
      if (!warned) logger.warn(`session watch: ${errorMessageFromUnknown(err)}`);
      warned = true;
      sessions = [];
      tracked.clear();
    } finally {
      polling = false;
    }
    const sig = JSON.stringify(sessions.map((s) => [s.id, s.workspaceAlias, s.state, s.activity, s.subagents]));
    if (sig !== signature) {
      signature = sig;
      onChange('sessions');
    }
  }

  return {
    poll,

    /** The open sessions as of the last poll, oldest first. @returns {OfficeSession[]} */
    current: () => sessions,

    /** Poll now, then every `intervalMs`. */
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), intervalMs);
      timer.unref();
      logger.info(`agent-runner: session watch every ${Math.round(intervalMs / 1000)}s of ${root}`);
      void poll();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
