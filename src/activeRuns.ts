import { readdir, readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { pidAlive } from './pidAlive.ts';
import { writeJsonAtomic } from './jsonFile.ts';
import { parseJsonObject } from './narrow.ts';
import { parseRunRecord } from './runLock.ts';
import type { RunRecord } from './runLock.ts';
import { parseAgentProgress } from './agentBackend/index.ts';
import type { AgentProgress } from './agentBackend/index.ts';

/**
 * One `active/<runId>.json` file per in-flight run, rewritten (throttled) as it progresses and
 * removed when it finishes. The Redis lock says *whether* a run is active; these files carry its
 * live progress to the terminal CLIs, and outlive the runner process so a crash leaves a trace.
 * Writes never throw: telemetry must not break a run.
 */
/**
 * `running`: the runner process that owns it is alive. `orphaned`: the runner died but the agent
 * process is still going, so nobody will report its result. `stale`: both are gone.
 */
export type RunHealth = 'running' | 'orphaned' | 'stale';

export type ActiveRunFile = RunRecord & Partial<AgentProgress> & { updatedAt?: string };

export type ActiveRun = ActiveRunFile & { health: RunHealth };

export const PROGRESS_THROTTLE_MS = 1500;

export function createActiveRuns({ dir, isAlive = pidAlive, throttleMs = PROGRESS_THROTTLE_MS, now = Date.now }: { dir: string; isAlive?: (pid: number | null | undefined) => boolean; throttleMs?: number; now?: () => number }) {
  const activeDir = join(dir, 'active');

  /**
   * @param opts `ownersGone`: judge health by the agent pid alone
   *   (on runner startup, every file belongs to a previous process whose pid may have been reused).
   * @returns oldest first
   */
  async function list({ ownersGone = false }: { ownersGone?: boolean } = {}): Promise<ActiveRun[]> {
    let names;
    try {
      names = await readdir(activeDir);
    } catch {
      return [];
    }
    const runs: ActiveRun[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        // only `track` writes these files, so a runId is enough to skip a torn or foreign one
        const o = parseJsonObject(await readFile(join(activeDir, name), 'utf8'));
        const record = parseRunRecord(o);
        if (!o || !record) continue;
        const run: ActiveRunFile = { ...record, ...parseAgentProgress(o), ...(typeof o.updatedAt === 'string' ? { updatedAt: o.updatedAt } : {}) };
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
     */
    track(record: RunRecord) {
      let rec = record;
      const path = join(activeDir, `${record.runId}.json`);
      let finished = false;
      let lastWrite = now();
      let pending: AgentProgress | null = null;
      /** the progress last written, kept when the record changes */
      let written: AgentProgress | null = null;
      let timer: NodeJS.Timeout | null = null;
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (fn: () => Promise<unknown>) => (chain = chain.then(fn).catch(() => {}));
      const write = (p: AgentProgress | null) =>
        enqueue(async () => {
          if (finished) return;
          written = p ?? written;
          await writeJsonAtomic(path, { ...rec, ...(written ?? {}), updatedAt: new Date(now()).toISOString() });
        });

      const ready = write(null);

      function update(p: AgentProgress) {
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
        /**
         * Rewrite the record (same runId) now, unthrottled, keeping the progress.
         */
        setRecord(next: RunRecord) {
          rec = next;
          return write(null);
        },
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
     * @param opts see `list`
     * @returns removed runIds
     */
    async removeStale(opts?: { ownersGone?: boolean }): Promise<string[]> {
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
