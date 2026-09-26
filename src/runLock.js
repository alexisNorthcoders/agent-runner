/**
 * Single-flight lock for agent runs, in Redis so the safe-restart CLI (and later the bot) can see
 * it. A request while the lock is held waits in the run queue (src/runQueue.js). The lock value is the
 * active run's record, which doubles as the "interrupted run" marker read on startup.
 *
 * @typedef {{
 *   runId: string,
 *   kind?: string,
 *   replyTo?: string,
 *   startedAt?: string,
 *   label?: string,
 *   workspaceRoot?: string,
 *   logPath?: string,
 *   ownerPid?: number,
 *   agentPid?: number | null,
 *   workspaceAlias?: string,
 *   issueNumber?: number,
 *   trigger?: 'manual' | 'cron',
 * }} RunRecord
 */

export const LOCK_KEY = 'agent-runner:lock';
/** runId reported for a lock whose value can't be parsed. */
export const UNKNOWN_RUN_ID = 'unknown';

/** `run <id> (<label>)`, for user-facing messages. @param {RunRecord} rec */
export const describeRun = (rec) => `run ${rec.runId}${rec.label ? ` (${rec.label})` : ''}`;

/**
 * @param {{ store: import('./redisStore.js').Store, ttlSeconds: number, key?: string }} p
 *   `ttlSeconds` must outlive the longest run; it only matters if the runner dies without releasing.
 */
export function createRunLock({ store, ttlSeconds, key = LOCK_KEY }) {
  /** @returns {Promise<RunRecord | null>} */
  async function current() {
    const raw = await store.get(key);
    if (raw == null) return null;
    try {
      const rec = JSON.parse(raw);
      if (rec && typeof rec.runId === 'string') return rec;
    } catch {
      /* fall through */
    }
    return { runId: UNKNOWN_RUN_ID };
  }

  return {
    current,
    /** @param {RunRecord} record @returns {Promise<boolean>} true if this run now holds the lock */
    tryAcquire: (record) => store.setIfAbsent(key, JSON.stringify(record), ttlSeconds),
    /**
     * Rewrite the holder's record (e.g. once the agent pid is known). Check-then-set is not atomic,
     * which is fine: only the runner process that holds the lock ever writes it.
     * @param {RunRecord} record
     */
    async update(record) {
      if ((await current())?.runId !== record.runId) return false;
      return store.replaceIfPresent(key, JSON.stringify(record));
    },
    /** @param {string} runId @returns {Promise<boolean>} */
    release: (runId) => store.deleteIfField(key, 'runId', runId),
    /** Drop the lock regardless of holder (startup recovery of a dead process's run). */
    forceClear: () => store.del(key),
  };
}
