import { isRecord, parseJsonObject } from './narrow.ts';
import type { Store } from './redisStore.ts';

/**
 * Single-flight lock for agent runs, in Redis so the safe-restart CLI (and later the bot) can see
 * it. A request while the lock is held waits in the run queue (src/runQueue.ts). The lock value is the
 * active run's record, which doubles as the "interrupted run" marker read on startup.
 */
/** `cron`: the cron issue tracer. `schedule`: a scheduled job. `manual`: WhatsApp or HTTP. */
export type RunTrigger = 'manual' | 'cron' | 'schedule';

/**
 * A scheduled job's run has `kind: 'job'`, `trigger: 'schedule'`, its `jobName` and `room`, and
 * `agentPid` is its command's pid. `inferredWorkspace`: the allowlisted workspace a freeform run
 * turned out to work in (its first edit or command there), once known; it never changes.
 */
export type RunRecord = {
  runId: string;
  kind?: string;
  replyTo?: string;
  startedAt?: string;
  label?: string;
  workspaceRoot?: string;
  logPath?: string;
  ownerPid?: number;
  agentPid?: number | null;
  workspaceAlias?: string;
  inferredWorkspace?: string;
  parentRunId?: string;
  issueNumber?: number;
  trigger?: RunTrigger;
  jobName?: string;
  room?: string;
};

const RUN_TRIGGERS: readonly RunTrigger[] = ['manual', 'cron', 'schedule'];
const STRING_FIELDS = ['kind', 'replyTo', 'startedAt', 'label', 'workspaceRoot', 'logPath', 'workspaceAlias', 'inferredWorkspace', 'parentRunId', 'jobName', 'room'] as const;
const NUMBER_FIELDS = ['ownerPid', 'issueNumber'] as const;

/** A run record's well-typed fields (a lock value, a run's active file). Null without a string `runId`. */
export function parseRunRecord(o: unknown): RunRecord | null {
  if (!isRecord(o) || typeof o.runId !== 'string') return null;
  const rec: RunRecord = { runId: o.runId };
  for (const k of STRING_FIELDS) {
    const v = o[k];
    if (typeof v === 'string') rec[k] = v;
  }
  for (const k of NUMBER_FIELDS) {
    const v = o[k];
    if (typeof v === 'number') rec[k] = v;
  }
  if (typeof o.agentPid === 'number' || o.agentPid === null) rec.agentPid = o.agentPid;
  const trigger = RUN_TRIGGERS.find((t) => t === o.trigger);
  if (trigger) rec.trigger = trigger;
  return rec;
}

export const LOCK_KEY = 'agent-runner:lock';
/** runId reported for a lock whose value can't be parsed. */
export const UNKNOWN_RUN_ID = 'unknown';

/** `run <id> (<label>)`, for user-facing messages. */
export const describeRun = (rec: RunRecord) => `run ${rec.runId}${rec.label ? ` (${rec.label})` : ''}`;

/** `ttlSeconds` must outlive the longest run; it only matters if the runner dies without releasing. */
export function createRunLock({ store, ttlSeconds, key = LOCK_KEY }: { store: Store; ttlSeconds: number; key?: string }) {
  async function current(): Promise<RunRecord | null> {
    const raw = await store.get(key);
    if (raw == null) return null;
    return parseRunRecord(parseJsonObject(raw)) ?? { runId: UNKNOWN_RUN_ID };
  }

  return {
    current,
    /** @returns true if this run now holds the lock */
    tryAcquire: (record: RunRecord): Promise<boolean> => store.setIfAbsent(key, JSON.stringify(record), ttlSeconds),
    /**
     * Rewrite the holder's record (e.g. once the agent pid is known). Check-then-set is not atomic,
     * which is fine: only the runner process that holds the lock ever writes it.
     */
    async update(record: RunRecord) {
      if ((await current())?.runId !== record.runId) return false;
      return store.replaceIfPresent(key, JSON.stringify(record));
    },
    release: (runId: string): Promise<boolean> => store.deleteIfField(key, 'runId', runId),
    /** Drop the lock regardless of holder (startup recovery of a dead process's run). */
    forceClear: () => store.del(key),
  };
}
