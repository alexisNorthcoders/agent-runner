import { pidAlive } from './pidAlive.js';

/**
 * One snapshot of the runner's state, shared by `claude:status` (inside the service) and the
 * terminal CLIs (a separate process). Everything but the pause flag comes from files under the
 * logs dir, so the CLIs work while the runner is down. Redis being down must not hang or fail a
 * status call, so the pause lookup is time-boxed and becomes `'unknown'`.
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
 * @param {{
 *   activeRuns: Pick<ReturnType<typeof import('./activeRuns.js').createActiveRuns>, 'list'>,
 *   history: Pick<ReturnType<typeof import('./runHistory.js').createRunHistory>, 'read'>,
 *   readCron: () => Promise<import('./cronState.js').CronState | null>,
 *   readPause: () => Promise<import('./pauseFlag.js').PauseRecord | null>,
 *   isAlive?: (pid: number) => boolean,
 *   now?: () => number,
 *   pauseTimeoutMs?: number,
 * }} deps
 * @returns {Promise<StatusSnapshot>}
 */
export async function collectStatus({ activeRuns, history, readCron, readPause, isAlive = pidAlive, now = Date.now, pauseTimeoutMs = PAUSE_LOOKUP_TIMEOUT_MS }) {
  const t = now();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('unknown'), pauseTimeoutMs);
  });
  const pause = Promise.race([readPause().catch(() => 'unknown'), timeout]).finally(() => clearTimeout(timer));
  const [active, cron, recent, paused] = await Promise.all([activeRuns.list(), readCron(), history.read({ sinceMs: t - WEEK_MS }), pause]);
  return {
    now: t,
    active,
    paused: /** @type {StatusSnapshot['paused']} */ (paused),
    cron,
    cronAlive: cron ? isAlive(cron.pid) : false,
    history: recent,
  };
}
