import { pidAlive } from './pidAlive.ts';
import type { ActiveRun, createActiveRuns } from './activeRuns.ts';
import type { PauseRecord } from './pauseFlag.ts';
import type { CronState } from './cronState.ts';
import type { HistoryEntry, createRunHistory } from './runHistory.ts';
import type { QueuedRun } from './runQueue.ts';
import type { ManualPause } from './manualPause.ts';
import type { UsageLimitPause } from './usageLimitPause.ts';
import type { RunRecord } from './runLock.ts';
import type { OfficeSession } from './sessionWatch.ts';

/**
 * One snapshot of the runner's state, shared by `claude:status` (inside the service) and the
 * terminal CLIs (a separate process). Runs and history come from files under the logs dir, so the
 * CLIs work while the runner is down. The pause flag, lock and cron state come from Redis, and
 * Redis being down must not hang or fail a status call, so those lookups are time-boxed. The lock
 * catches a run that holds it without an active file (mid Joplin fetch, or its first write failed).
 */
/**
 * `history` covers the last 7 days, newest first. `lock` is the lock holder (null when free or
 * unreadable).
 */
export type StatusSnapshot = {
  now: number;
  active: ActiveRun[];
  paused: PauseRecord | null | 'unknown';
  cron: CronState | null;
  cronAlive: boolean;
  history: HistoryEntry[];
  queue?: QueuedRun[];
  manualPauses?: ManualPause[];
  usageLimit?: UsageLimitPause | null;
  lock?: RunRecord | null;
  sessions?: OfficeSession[];
};

export const PAUSE_LOOKUP_TIMEOUT_MS = 1500;
const WEEK_MS = 7 * 864e5;

/** `read`'s result, or `fallback` if it fails or takes longer than `ms`. */
function timeBoxed<T, F>(read: () => Promise<T>, fallback: F, ms: number): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([read().catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

export async function collectStatus({
  activeRuns,
  history,
  readCron,
  readPause,
  readLock = async () => null,
  readQueue = async () => [],
  readManualPauses = async () => [],
  readUsageLimit = async () => null,
  readSessions = async () => [],
  isAlive = pidAlive,
  now = Date.now,
  pauseTimeoutMs = PAUSE_LOOKUP_TIMEOUT_MS,
}: {
    activeRuns: Pick<ReturnType<typeof createActiveRuns>, 'list'>;
    history: Pick<ReturnType<typeof createRunHistory>, 'read'>;
    readCron: () => Promise<CronState | null>;
    readPause: () => Promise<PauseRecord | null>;
    readLock?: () => Promise<RunRecord | null>;
    readQueue?: () => Promise<QueuedRun[]>;
    readManualPauses?: () => Promise<ManualPause[]>;
    readUsageLimit?: () => Promise<UsageLimitPause | null>;
    readSessions?: () => Promise<OfficeSession[]>;
    isAlive?: (pid: number | null | undefined) => boolean;
    now?: () => number;
    pauseTimeoutMs?: number;
  }): Promise<StatusSnapshot> {
  const t = now();
  const [active, cron, recent, paused, lock, queue, manualPauses, usageLimit, sessions] = await Promise.all([
    activeRuns.list(),
    timeBoxed(readCron, null, pauseTimeoutMs),
    history.read({ sinceMs: t - WEEK_MS }),
    timeBoxed(readPause, 'unknown' as const, pauseTimeoutMs),
    timeBoxed(readLock, null, pauseTimeoutMs),
    timeBoxed(readQueue, [], pauseTimeoutMs),
    timeBoxed(readManualPauses, [], pauseTimeoutMs),
    timeBoxed(readUsageLimit, null, pauseTimeoutMs),
    timeBoxed(readSessions, [], pauseTimeoutMs),
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
    queue,
    manualPauses,
    usageLimit,
    lock,
    sessions,
  };
}
