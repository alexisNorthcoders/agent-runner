import { pidAlive } from './pidAlive.js';

/**
 * One snapshot of the runner's state, shared by `claude:status` (inside the service) and the
 * terminal CLIs (a separate process). Runs, history and cron state come from files under the logs
 * dir, so the CLIs work while the runner is down. The pause flag and lock come from Redis, and
 * Redis being down must not hang or fail a status call, so those lookups are time-boxed. The lock
 * catches a run that holds it without an active file (mid Joplin fetch, or its first write failed).
 *
 * @typedef {{
 *   now: number,
 *   active: import('./activeRuns.js').ActiveRun[],
 *   paused: import('./pauseFlag.js').PauseRecord | null | 'unknown',
 *   cron: import('./cronState.js').CronState | null,
 *   cronAlive: boolean,
 *   history: import('./runHistory.js').HistoryEntry[],
 * }} StatusSnapshot
 *   `history` covers the last 7 days, newest first.
 */

export const PAUSE_LOOKUP_TIMEOUT_MS = 1500;
const WEEK_MS = 7 * 864e5;

/**
 * @template T, F
 * @param {() => Promise<T>} read
 * @param {F} fallback returned if `read` fails or takes longer than `ms`
 * @param {number} ms
 * @returns {Promise<T | F>}
 */
function timeBoxed(read, fallback, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([read().catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {{
 *   activeRuns: Pick<ReturnType<typeof import('./activeRuns.js').createActiveRuns>, 'list'>,
 *   history: Pick<ReturnType<typeof import('./runHistory.js').createRunHistory>, 'read'>,
 *   readCron: () => Promise<import('./cronState.js').CronState | null>,
 *   readPause: () => Promise<import('./pauseFlag.js').PauseRecord | null>,
 *   readLock?: () => Promise<import('./runLock.js').RunRecord | null>,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   pauseTimeoutMs?: number,
 * }} deps
 * @returns {Promise<StatusSnapshot>}
 */
export async function collectStatus({
  activeRuns,
  history,
  readCron,
  readPause,
  readLock = async () => null,
  isAlive = pidAlive,
  now = Date.now,
  pauseTimeoutMs = PAUSE_LOOKUP_TIMEOUT_MS,
}) {
  const t = now();
  const [active, cron, recent, paused, lock] = await Promise.all([
    activeRuns.list(),
    readCron(),
    history.read({ sinceMs: t - WEEK_MS }),
    timeBoxed(readPause, /** @type {const} */ ('unknown'), pauseTimeoutMs),
    timeBoxed(readLock, null, pauseTimeoutMs),
  ]);
  if (lock && !active.some((r) => r.runId === lock.runId)) {
    const health = isAlive(lock.ownerPid) ? 'running' : isAlive(lock.agentPid) ? 'orphaned' : 'stale';
    active.push({ ...lock, health });
  }
  return {
    now: t,
    active,
    paused,
    cron,
    cronAlive: cron ? isAlive(cron.pid) : false,
    history: recent,
  };
}
