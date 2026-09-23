import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { pidAlive } from './pidAlive.js';

/**
 * One `active/<runId>.json` file per in-flight run, rewritten (throttled) as it progresses and
 * removed when it finishes. The Redis lock says *whether* a run is active; these files carry its
 * live progress to the terminal CLIs, and outlive the runner process so a crash leaves a trace.
 * Writes never throw: telemetry must not break a run.
 *
 * @typedef {'running' | 'orphaned' | 'stale'} RunHealth
 *   `running`: the runner process that owns it is alive. `orphaned`: the runner died but the agent
 *   process is still going, so nobody will report its result. `stale`: both are gone.
 *
 * @typedef {import('./runLock.js').RunRecord & Partial<import('./agentBackend/index.js').AgentProgress> & { updatedAt?: string }} ActiveRunFile
 * @typedef {ActiveRunFile & { health: RunHealth }} ActiveRun
 */

export const PROGRESS_THROTTLE_MS = 1500;

async function writeJsonAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data), 'utf8');
  await rename(tmp, path);
}

/**
 * @param {{ dir: string, isAlive?: (pid: number) => boolean, throttleMs?: number, now?: () => number }} p
 */
export function createActiveRuns({ dir, isAlive = pidAlive, throttleMs = PROGRESS_THROTTLE_MS, now = Date.now }) {
  const activeDir = join(dir, 'active');

  /**
   * @param {{ ownersGone?: boolean }} [opts] `ownersGone`: judge health by the agent pid alone
   *   (on runner startup, every file belongs to a previous process whose pid may have been reused).
   * @returns {Promise<ActiveRun[]>} oldest first
   */
  async function list({ ownersGone = false } = {}) {
    let names;
    try {
      names = await readdir(activeDir);
    } catch {
      return [];
    }
    /** @type {ActiveRun[]} */
    const runs = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        /** @type {ActiveRunFile} */
        const run = JSON.parse(await readFile(join(activeDir, name), 'utf8'));
        if (typeof run?.runId !== 'string') continue;
        const health = !ownersGone && isAlive(run.ownerPid) ? 'running' : isAlive(run.agentPid) ? 'orphaned' : 'stale';
        runs.push({ ...run, health });
      } catch {
        /* corrupt: skip */
      }
    }
    return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  }

  return {
    list: () => list(),

    /**
     * Publish a run as active. `update` is throttled, and a skipped write is flushed shortly after
     * (trailing edge). `finish` removes the file; nothing is written after it.
     * @param {import('./runLock.js').RunRecord} record
     */
    track(record) {
      const path = join(activeDir, `${record.runId}.json`);
      let finished = false;
      let lastWrite = now();
      /** @type {import('./agentBackend/index.js').AgentProgress | null} */
      let pending = null;
      /** @type {NodeJS.Timeout | null} */
      let timer = null;
      /** @type {Promise<unknown>} */
      let chain = Promise.resolve();
      /** @param {() => Promise<unknown>} fn */
      const enqueue = (fn) => (chain = chain.then(fn).catch(() => {}));
      /** @param {import('./agentBackend/index.js').AgentProgress | null} p */
      const write = (p) =>
        enqueue(async () => {
          if (finished) return;
          await writeJsonAtomic(path, { ...record, ...(p ?? {}), updatedAt: new Date(now()).toISOString() });
        });

      const ready = enqueue(() => mkdir(activeDir, { recursive: true })).then(() => write(null));

      /** @param {import('./agentBackend/index.js').AgentProgress} p */
      function update(p) {
        if (finished) return chain;
        pending = p;
        const wait = throttleMs - (now() - lastWrite);
        if (wait > 0) {
          timer ??= setTimeout(() => {
            timer = null;
            if (pending) update(pending);
          }, wait).unref();
          return chain;
        }
        lastWrite = now();
        pending = null;
        return write(p);
      }

      return {
        /** Settles once the first write has been attempted. */
        ready,
        update,
        finish() {
          if (timer) clearTimeout(timer);
          timer = null;
          finished = true;
          return enqueue(() => unlink(path));
        },
      };
    },

    /**
     * Delete the files of `stale` runs, e.g. left by a restart mid-run. `orphaned` ones are kept:
     * their agent is still working and the file is the only trace of it.
     * @param {{ ownersGone?: boolean }} [opts] see `list`
     * @returns {Promise<string[]>} removed runIds
     */
    async removeStale(opts) {
      const removed = [];
      for (const run of await list(opts)) {
        if (run.health !== 'stale') continue;
        try {
          await unlink(join(activeDir, `${run.runId}.json`));
          removed.push(run.runId);
        } catch {
          /* already gone */
        }
      }
      return removed;
    },
  };
}
