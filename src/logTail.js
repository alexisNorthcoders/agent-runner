import { open } from 'fs/promises';
import { StringDecoder } from 'string_decoder';
import { maskSecrets } from './maskSecrets.js';

/**
 * Follows the active run's log for the office feed's live tail. It polls `current()` (the run this
 * process is executing and the log its agent writes now: the first pass, then an autofix pass's
 * own file) and reads what was appended since the last poll. Every line is masked
 * (src/maskSecrets.js) and capped before anyone sees it, and the last `tailLines` are kept so a
 * client that connects mid-run gets the recent tail, not the whole log.
 *
 * Listeners get `reset: true` with the whole tail when a new run starts (the pane clears) or its log
 * changes (it is resent), and `reset: false` with just the new lines otherwise. When the run ends the tail is dropped quietly:
 * clients keep what they have until the next run.
 *
 * It only polls between `start()` and `stop()` (the feed starts it while anyone is connected).
 *
 * @typedef {{ runId: string | null, reset: boolean, lines: string[] }} LogLines
 * @typedef {{ runId: string, logPath: string, fromByte?: number }} ActiveLog
 *   `fromByte`: where the run's output starts, in a log other runs append to (a scheduled job's).
 */

export const LOG_POLL_MS = 500;
export const LOG_TAIL_LINES = 200;
export const LOG_MAX_LINE_CHARS = 2000;
/** How far back the first read of a log goes looking for its last lines. */
const TAIL_BYTES = 256 * 1024;
/** The most one poll reads, so a burst is streamed over a few polls. */
const MAX_READ_BYTES = 1024 * 1024;

/**
 * @param {{
 *   current: () => ActiveLog | null,
 *   pollMs?: number,
 *   tailLines?: number,
 *   maxLineChars?: number,
 *   logger?: Pick<Console, 'warn'>,
 * }} p
 */
export function createLogTail({ current, pollMs = LOG_POLL_MS, tailLines = LOG_TAIL_LINES, maxLineChars = LOG_MAX_LINE_CHARS, logger = console }) {
  /** @type {Set<(e: LogLines) => void>} */
  const listeners = new Set();
  /** Bumped by start and stop, so a poll from an earlier session changes nothing. */
  let session = 0;
  let running = false;
  /** @type {Promise<void>} */
  let firstPoll = Promise.resolve();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @type {string | null} */
  let runId = null;
  /** @type {string[]} */
  let lines = [];
  /** @type {string | null} */
  let path = null;
  /** Bytes of `path` read so far; null until its tail has been read. @type {number | null} */
  let offset = null;
  let partial = '';
  let decoder = new StringDecoder('utf8');
  /** A new run was seen and listeners haven't been told yet. */
  let resetPending = false;

  /** Drop the half-read line, e.g. when the next bytes aren't the ones after it. */
  function resetReader() {
    partial = '';
    decoder = new StringDecoder('utf8');
  }

  function forget() {
    runId = null;
    lines = [];
    path = null;
    offset = null;
    resetPending = false;
    resetReader();
  }

  /** @param {string} line */
  function clean(line) {
    const masked = maskSecrets(line.endsWith('\r') ? line.slice(0, -1) : line);
    return masked.length <= maxLineChars ? masked : `${masked.slice(0, maxLineChars)}… (${masked.length - maxLineChars} more chars)`;
  }

  /** @param {LogLines} e */
  function emit(e) {
    for (const fn of listeners) {
      try {
        fn(e);
      } catch (err) {
        logger.warn(`log tail listener failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * The bytes of `file` appended since the last read (on the first read, up to TAIL_BYTES from its
   * end but not before `fromByte`, from the first whole line: `midLine` says the first line read is
   * the end of one that started earlier). Null if it can't be read (e.g. not
   * created yet).
   * @param {string} file
   * @param {number} fromByte
   */
  async function readNew(file, fromByte) {
    let fh;
    try {
      fh = await open(file, 'r');
    } catch {
      return null;
    }
    try {
      const { size } = await fh.stat();
      let from = offset;
      let midLine = false;
      if (from == null || size < from) {
        // a log shorter than where the run began was truncated: all of it is new
        const start = fromByte <= size ? fromByte : 0;
        from = Math.max(start, size - TAIL_BYTES);
        // starting anywhere but just after a newline would emit a truncated first line
        if (from > 0) {
          const prev = Buffer.alloc(1);
          await fh.read(prev, 0, 1, from - 1);
          midLine = prev[0] !== 0x0a;
        }
      }
      const length = Math.min(size - from, MAX_READ_BYTES);
      const buf = Buffer.alloc(length);
      const { bytesRead } = length ? await fh.read(buf, 0, length, from) : { bytesRead: 0 };
      return { from, to: from + bytesRead, midLine, bytes: buf.subarray(0, bytesRead) };
    } finally {
      await fh.close();
    }
  }

  async function poll(/** @type {number} */ s) {
    const cur = current();
    if (!cur) {
      if (runId !== null) forget();
      return;
    }
    if (cur.runId !== runId) {
      forget();
      runId = cur.runId;
      resetPending = true;
    }
    if (cur.logPath !== path) {
      // e.g. the autofix pass: clients get the run's tail again, now from the new log
      path = cur.logPath;
      offset = null;
      resetPending = true;
      resetReader();
    }
    const read = await readNew(path, cur.fromByte ?? 0).catch((err) => {
      logger.warn(`log tail: cannot read ${path}: ${err?.message || err}`);
      return null;
    });
    // the run or its log may have changed while reading; the next poll starts over
    if (s !== session || current()?.logPath !== path || cur.runId !== runId) return;
    /** @type {string[]} */
    let fresh = [];
    if (read) {
      if (offset == null || read.from !== offset) resetReader();
      offset = read.to;
      const pieces = (partial + decoder.write(read.bytes)).split('\n');
      partial = /** @type {string} */ (pieces.pop());
      if (read.midLine) pieces.shift();
      fresh = pieces.map(clean);
      lines.push(...fresh);
      if (lines.length > tailLines) lines.splice(0, lines.length - tailLines);
    }
    if (resetPending) {
      resetPending = false;
      emit({ runId, reset: true, lines: [...lines] });
    } else if (fresh.length) emit({ runId, reset: false, lines: fresh });
  }

  /** @param {number} s */
  function loop(s) {
    timer = setTimeout(() => {
      timer = null;
      poll(s).finally(() => {
        if (s === session) loop(s);
      });
    }, pollMs);
    timer.unref();
  }

  return {
    /**
     * Start following (a no-op if already started). Settles once the first poll is done, so `tail()`
     * then holds the active run's recent lines.
     */
    start() {
      if (running) return firstPoll;
      running = true;
      const s = ++session;
      forget();
      firstPoll = poll(s).finally(() => {
        if (s === session) loop(s);
      });
      return firstPoll;
    },

    /** Stop following and forget the tail. */
    stop() {
      running = false;
      session++;
      if (timer) clearTimeout(timer);
      timer = null;
      forget();
    },

    /** The active run's recent lines, masked. @returns {{ runId: string | null, lines: string[] }} */
    tail: () => ({ runId, lines: [...lines] }),

    /** @param {(e: LogLines) => void} fn @returns {() => void} unsubscribe */
    onLines(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
