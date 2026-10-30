/**
 * The runner: turns a `claude…` command into at most one agent run at a time and reports every
 * outcome through the outbox. A request that arrives while busy (or paused) waits in the run queue
 * and starts when the runs ahead of it have finished. HTTP (src/http.ts) and startup (src/main.ts)
 * are thin shells over it.
 */

import { randomUUID } from 'crypto';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { parseCommand } from './commands.ts';
import { ALL, applyPauseCommand, describeManualPause } from './manualPause.ts';
import { OWNER } from './outbox.ts';
import { DEFAULT_JOB_TIMEOUT_MINUTES } from './scheduledJobs.ts';
import { decideSafeRestart } from './safeRestart.ts';
import { describeRun, UNKNOWN_RUN_ID } from './runLock.ts';
import { describeUsageLimitPause } from './usageLimitPause.ts';
import { pidAlive } from './pidAlive.ts';
import { createWorkspaceInference } from './workspaceInference.ts';
import { formatDuration, renderHistoryText, renderStatusText } from './statusFormat.ts';
import { REQUEUED_NOTE } from './runQueue.ts';
import { modelFromLabels } from './modelLabel.ts';
import { sumJobUsage, USAGE_FILE_ENV } from './jobUsage.ts';
import { errorText, isRecord } from './narrow.ts';
import { lastNonEmptyLine } from './issueGrill.ts';
import { specRunExpectation } from './specCommands.ts';
import type { AgentModelChoice, AgentResult, AgentProgress, AgentBackend, AgentTouch, AgentStartOptions } from './agentBackend/index.ts';
import type { RunRecord, createRunLock } from './runLock.ts';
import type { JobResult, JobLauncher } from './jobProcess.ts';
import type { createActiveRuns } from './activeRuns.ts';
import type { SpecCommands } from './specCommands.ts';
import type { IssueRunResult, IssuePipeline } from './issuePipeline/index.ts';
import type { createPauseFlag } from './pauseFlag.ts';
import type { createManualPause } from './manualPause.ts';
import type { createUsageLimitPause } from './usageLimitPause.ts';
import type { createRunQueue, QueuedRun, ContinuationParent } from './runQueue.ts';
import type { createOutbox } from './outbox.ts';
import type { createRunHistory, HistoryEntry } from './runHistory.ts';
import type { StatusSnapshot } from './statusCollect.ts';
import type { NotifyChange } from './stateChanges.ts';
import type { RunAgent, PostRunResult } from './issuePipeline/postRun.ts';
import type { ScheduledJob } from './scheduledJobs.ts';
import type { ActiveLog } from './logTail.ts';

const MAX_OUTBOX_TEXT = 30_000;
const STDERR_TAIL = 800;
/** A manual request the usage limit stopped within this many turns hadn't started, so it's re-queued. */
const MAX_UNSTARTED_TURNS = 1;

/** Timestamp-based run id, safe in file names. */
export const timestampRunId = () => new Date().toISOString().replace(/[:.]/g, '-');

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const cap = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}\n…(truncated, see the log)`);

/**
 * `opus (workspace)` for a model that didn't come from the runner default, else ''.
 */
export const modelNote = (m: AgentModelChoice | undefined) => (m && m.source !== 'default' ? `${m.name} (${m.source})` : '');

/** A Parent run that ended one of these ways gets the lead line in its Continuation's instructions. */
const EARLY_END_OUTCOMES = new Set(['stopped', 'limited', 'timeout', 'failed']);

const modelSuffix = (m: AgentModelChoice | undefined) => (modelNote(m) ? `, model ${modelNote(m)}` : '');

export function formatRunResult(rec: RunRecord, r: AgentResult) {
  const name = capitalize(describeRun(rec));
  const cost = r.usage.costUsd != null ? `, $${r.usage.costUsd.toFixed(2)}` : '';
  const logLine = `Log: ${r.logPath}`;
  const tail = r.stderr.trim() ? `\n${r.stderr.trim().slice(-STDERR_TAIL)}` : '';
  if (r.sessionMissing) return `${name} failed: the session of run ${rec.parentRunId ?? 'its parent'} no longer exists (Claude may have deleted its transcript), so it can't be continued. Start a fresh run with claude <instructions>.\n${logLine}`;
  switch (r.outcome) {
    case 'success':
      return cap(`${name} finished (${r.usage.turns} turns${cost}).\n\n${r.text.trim() || '(no final message)'}`, MAX_OUTBOX_TEXT);
    case 'stopped':
      return `${name} was stopped by claude:stop.\n${logLine}`;
    case 'timeout':
      return `${name} timed out and was killed.\n${logLine}`;
    case 'limited':
      return `${name} stopped: the agent hit its usage limit.\n${logLine}`;
    case 'spawn_error':
      return `${name} could not start the agent.${tail}`;
    default:
      return cap(`${name} failed (exit ${r.exitCode ?? 'n/a'}).${tail}\n${logLine}`, MAX_OUTBOX_TEXT);
  }
}

/**
 * A failed scheduled job's one-line report. Null for a success, which stays quiet.
 */
export function formatJobResult(rec: RunRecord, r: JobResult, durationMs: number) {
  const name = `Scheduled job ${rec.jobName}`;
  const log = rec.logPath ? ` Log: ${rec.logPath}` : '';
  const took = formatDuration(durationMs);
  switch (r.outcome) {
    case 'success':
      return null;
    case 'stopped':
      return `${name} was stopped by claude:stop after ${took}.${log}`;
    case 'timeout':
      return `${name} timed out after ${took} and was killed.${log}`;
    case 'spawn_error':
      return `${name} could not start: ${r.error}`;
    default:
      return `${name} failed (${r.signal ? `killed by ${r.signal}` : `exit ${r.exitCode ?? 'n/a'}`}) after ${took}.${log}`;
  }
}

/**
 * `passLogPath` is the log the latest follow-up (autofix) pass writes; the run's own log is
 * `record.logPath`. `logFrom` is where this run's output starts in a log other runs append to
 * (a scheduled job's `logFile`). `limitNotice` is `owner`'s message about a usage limit the run
 * hit, sent with its report. `requeued` says the usage limit stopped it before it started, so its
 * request is back at the head of the queue.
 */
export type ActiveRun = {
  record: StartedRecord;
  run: { pid: number | null; stop: () => void };
  progress: AgentProgress | null;
  phase: 'agent' | 'post-run' | 'job';
  stopRequested: boolean;
  tracker: ReturnType<ReturnType<typeof createActiveRuns>['track']>;
  followUps?: Array<{ label: string; outcome: string; logPath: string; costUsd: number | null; turns: number }>;
  passLogPath?: string;
  logFrom?: number;
  limitNotice?: string;
  requeued?: boolean;
};

/**
 * How an issue run ended, for the cron: its result, and whether an approved PR's merge failed only
 * on a network error (so the cron works the PR again instead of setting it aside).
 */
export type IssueRunOutcome = { result: IssueRunResult; mergeNetworkError: boolean };

/** The record of a run this runner started: `newRecord` always sets these fields. */
type StartedRecord = RunRecord & Required<Pick<RunRecord, 'kind' | 'label' | 'replyTo' | 'workspaceRoot' | 'logPath' | 'startedAt'>>;

/** A finished run's outbox text (null sends nothing) and the fields it adds to its history row. */
type RunReport = { text: string | null; history?: Record<string, unknown> };

/** A Continuation's Parent once its session is known. */
type ResolvedParent = Exclude<ContinuationParent, { pending: true }>;

/** A freeform, Joplin or `claude:more` request about to start, its Parent resolved. */
type AgentRequest = Extract<QueuedRun['cmd'], { kind: 'freeform' | 'joplin' }> | { kind: 'more'; instructions: string; parent: ResolvedParent; model?: string };

type StartReply = { reply: string; started: boolean; refused?: 'busy' | 'paused' };

export type RunnerDeps = {
  lock: ReturnType<typeof createRunLock>;
  pause: ReturnType<typeof createPauseFlag>;
  manualPause: ReturnType<typeof createManualPause>;
  usageLimit: ReturnType<typeof createUsageLimitPause>;
  queue: ReturnType<typeof createRunQueue>;
  outbox: ReturnType<typeof createOutbox>;
  backend: AgentBackend;
  history: Pick<ReturnType<typeof createRunHistory>, 'append' | 'read'>;
  activeRuns: Pick<ReturnType<typeof createActiveRuns>, 'track'>;
  statusSnapshot: () => Promise<StatusSnapshot>;
  joplin: { getNote: (query: string) => Promise<{ id: string; title: string; body: string }> };
  launchSafeRestart: (replyTo: string) => void;
  workspaces?: {
    resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }>;
    list?: () => Promise<Array<{ alias: string; root: string }>>;
  };
  issues?: Pick<IssuePipeline, 'prepare' | 'finish' | 'commitInterruptedWork'>;
  specs?: Pick<SpecCommands, 'reject' | 'prepare' | 'landed'>;
  jobs?: Pick<JobLauncher, 'start'>;
  jobTimeoutMs?: number;
  readUsageFile?: (path: string) => Promise<string>;
  workspaceRoot: string;
  logsDir: string;
  preamble: string;
  freeformPreamble?: string;
  newRunId?: () => string;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  stopOrphanAgent?: (pid: number) => Promise<boolean>;
  logSize?: (path: string) => Promise<number>;
  logger?: Pick<Console, 'error' | 'warn' | 'info'>;
  /**
   * Told about state that lives only here or in files (progress, phase, the run starting and
   * finishing); Redis state tells it through its store (src/stateChanges.ts).
   */
  onChange?: NotifyChange;
};

export function createRunner({
  lock,
  pause,
  manualPause,
  usageLimit,
  queue,
  outbox,
  backend,
  history,
  activeRuns,
  statusSnapshot,
  joplin,
  launchSafeRestart,
  workspaces,
  issues,
  specs,
  jobs,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MINUTES * 60_000,
  workspaceRoot,
  logsDir,
  preamble,
  freeformPreamble = preamble,
  newRunId = timestampRunId,
  now = Date.now,
  isAlive = pidAlive,
  stopOrphanAgent = async (pid) => (backend.stopOrphan ? backend.stopOrphan(pid) : false),
  logSize = async (path) => (await stat(path)).size,
  readUsageFile = (path) => readFile(path, 'utf8'),
  logger = console,
  onChange = () => {},
}: RunnerDeps) {
  /** The run this process is executing, if any. */
  let active: ActiveRun | null = null;
  /** Settles when the active run has been reported and its lock released. */
  let settled = Promise.resolve();
  /** The latest queue drain; one runs at a time. */
  let draining: Promise<void> | null = null;
  let lastDrain = Promise.resolve();

  const trackProgress = (runId: string) => (p: AgentProgress) => {
    if (active?.record.runId !== runId) return;
    active.progress = p;
    active.tracker.update(p);
    onChange('progress');
  };

  /**
   * The inferred workspace of freeform run `runId`, from its first edit or command in an allowlisted
   * workspace: set once on the active run, its lock record and active-run file, and later its
   * history row. Null when there's no allowlist to infer from.
   */
  function inferWorkspace(runId: string): ((t: AgentTouch) => void) | undefined {
    const list = workspaces?.list;
    if (!list) return undefined;
    const inference = createWorkspaceInference({
      workspaces: list,
      logger,
      async onInferred(alias) {
        const a = active;
        if (a?.record.runId !== runId || a.record.inferredWorkspace) return;
        a.record = { ...a.record, inferredWorkspace: alias };
        a.tracker.setRecord(a.record);
        await lock.update(a.record).catch(() => {});
        onChange('inferred-workspace');
      },
    });
    return (t) => {
      void inference.touch(t);
    };
  }

  const setPhase = (a: ActiveRun, phase: ActiveRun['phase']) => {
    a.phase = phase;
    onChange('phase');
  };

  /**
   * Why no run may start now: the safe-restart pause, the owner's general pause or the usage-limit
   * pause. Null when none is set.
   */
  async function pausedReason(): Promise<string | null> {
    const restarting = await pause.get();
    if (restarting) return restarting.reason;
    const byHand = await manualPause.general();
    if (byHand) return `paused by hand: ${describeManualPause(byHand, now())}`;
    const limited = await usageLimit.get();
    return limited ? `usage limit hit, ${describeUsageLimitPause({ ...limited, note: null }, now())}` : null;
  }

  /**
   * The agent hit its usage limit: hold new runs until it resets (never shortening a longer pause)
   * and keep `owner`'s one notice on the run, to send with its report. A later pass (the autofix)
   * hitting it again only rewrites the notice if it pushed the pause further, so it stays one message
   * naming the pause in force. `retry` (a manual request's first pass) goes back to the head of the
   * queue if the limit stopped it before it did any real work, so it runs by itself after the pause.
   */
  async function hitUsageLimit(a: ActiveRun, result: AgentResult, retry?: QueuedRun) {
    if (result.outcome !== 'limited' || !result.limit) return;
    try {
      const { pause: p, extended } = await usageLimit.extend(result.limit);
      // no pause, no re-queue: it would only start and hit the limit again
      if (!p) return;
      if (retry && result.usage.turns <= MAX_UNSTARTED_TURNS) {
        try {
          await queue.unshift({ ...retry, queuedAt: new Date(now()).toISOString() });
          a.requeued = true;
        } catch (err) {
          logger.error(`run ${a.record.runId}: could not re-queue the request:`, errorText(err));
        }
      }
      if (a.limitNotice && !extended) return;
      const n = await queue.length().catch(() => 0);
      const again = retry && a.requeued ? ` Re-queued "${retry.label}" at the head of the queue.` : '';
      a.limitNotice = `⏸ Usage limit hit: pausing agent runs ${describeUsageLimitPause(p, now())}.${again} ${n} request${n === 1 ? '' : 's'} queued.`;
    } catch (err) {
      logger.error(`run ${a.record.runId}: could not set the usage-limit pause:`, errorText(err));
    }
  }

  /**
   * Take the single-flight lock for `record`. Returns why it wasn't taken (with the reply), or null
   * once it's held.
   */
  async function acquire(record: RunRecord): Promise<{ why: 'busy' | 'paused'; reply: string } | null> {
    const paused = await pausedReason();
    if (paused) return { why: 'paused', reply: `agent-runner is paused (${paused}).` };
    if (!(await lock.tryAcquire(record))) {
      const cur = await lock.current();
      const what = cur ? ` ${capitalize(describeRun(cur))} is in progress.` : '';
      return { why: 'busy', reply: `Agent is busy.${what} Try again later.` };
    }
    // safe-restart may have paused between the check above and taking the lock; it re-checks the
    // lock after pausing, so checking the pause again here means one side always backs off
    const pausedNow = await pause.get();
    if (pausedNow) {
      await lock.release(record.runId);
      return { why: 'paused', reply: `agent-runner is paused (${pausedNow.reason}). Try again in a minute.` };
    }
    return null;
  }

  function newRecord(p: { kind: string; label: string; replyTo: string; workspaceRoot: string } & Partial<RunRecord>): StartedRecord {
    const runId = newRunId();
    return {
      runId,
      startedAt: new Date(now()).toISOString(),
      logPath: join(logsDir, `${runId}.log`),
      ownerPid: process.pid,
      agentPid: null,
      ...p,
    };
  }

  /**
   * Watch a started run that holds the lock until it ends, then in the background: report it,
   * append its history row, release the lock and start the next queued request. `report` turns the
   * result into the outbox text (or null to send nothing) and the history fields; if it throws,
   * `fallback` is used.
   */
  async function supervise<R extends { outcome: string; exitCode: number | null }>(
    record: StartedRecord,
    run: { pid: number | null; done: Promise<R>; stop: () => void },
    phase: 'agent' | 'job',
    report: (result: R, a: ActiveRun) => Promise<RunReport>,
    fallback: (result: R) => RunReport,
    extra: Pick<ActiveRun, 'logFrom'> = {}
  ) {
    const { runId } = record;
    const running = { ...record, agentPid: run.pid };
    const a: ActiveRun = { record: running, run, progress: null, phase, stopRequested: false, tracker: activeRuns.track(running), ...extra };
    active = a;
    onChange('run-started');
    await lock.update(a.record).catch(() => {});
    const done = (async () => {
      const result = await run.done;
      if (phase === 'agent') setPhase(a, 'post-run');
      let out;
      try {
        out = await report(result, a);
      } catch (err) {
        logger.error(`run ${runId}: report failed:`, err);
        out = fallback(result);
      }
      if (out.text) {
        try {
          await outbox.send({ replyTo: record.replyTo, runId, text: out.text });
        } catch (err) {
          logger.error(`run ${runId}: outbox write failed:`, errorText(err));
        }
      }
      const endedAt = now();
      try {
        await history.append({
          runId,
          kind: record.kind,
          label: record.label,
          replyTo: record.replyTo,
          workspaceRoot: record.workspaceRoot,
          logPath: record.logPath,
          startedAt: record.startedAt,
          endedAt: new Date(endedAt).toISOString(),
          ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
          durationMs: endedAt - Date.parse(record.startedAt),
          outcome: result.outcome,
          exitCode: result.exitCode,
          ...(a.record.inferredWorkspace ? { inferredWorkspace: a.record.inferredWorkspace } : {}),
          ...out.history,
        });
      } catch (err) {
        logger.warn(`run ${runId}: history write failed:`, errorText(err));
      }
    })();
    settled = done
      .catch((err) => logger.error(`run ${runId}: finish failed:`, err))
      .finally(async () => {
        // after the history write, so the CLIs never lose sight of the run
        await a.tracker.finish();
        if (active === a) active = null;
        onChange('run-ended');
        try {
          await lock.release(runId);
        } catch (err) {
          logger.error(`run ${runId}: lock release failed (expires on its own):`, errorText(err));
        }
        drainQueue();
      });
    return a;
  }

  /**
   * Start the agent for a run that holds the lock, then report in the background (`supervise`):
   * `report` turns the agent's result into the outbox text and extra history fields. Releases the
   * lock if the agent can't start. `opts.preamble` defaults to the issue-run preamble. `retry` is the
   * request to re-queue if the usage limit stops it before it starts (manual requests only).
   */
  async function launch(record: StartedRecord, opts: Omit<AgentStartOptions, 'logPath' | 'onProgress'>, report: (result: AgentResult, a: ActiveRun) => Promise<RunReport>, retry?: QueuedRun) {
    let run;
    try {
      run = await backend.start({ preamble, ...opts, logPath: record.logPath, onProgress: trackProgress(record.runId) });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      throw err;
    }
    const agentHistory = (result: AgentResult) => ({ backend: backend.name, logPath: result.logPath, ...result.usage, ...(result.limit ? { limit: result.limit } : {}) });
    const toOwner = (text: string) =>
      outbox.send({ replyTo: OWNER, runId: record.runId, text }).catch((err) => logger.error(`run ${record.runId}: outbox write failed:`, errorText(err)));
    await supervise(
      record,
      run,
      'agent',
      async (result, a) => {
        await hitUsageLimit(a, result, retry);
        let out;
        try {
          out = await report(result, a);
        } catch (err) {
          if (a.limitNotice) await toOwner(a.limitNotice);
          throw err;
        }
        let text = out.text;
        const note = modelNote(run.model);
        if (text && note) text = `${text}\nModel: ${note}`;
        if (a.limitNotice) {
          // owner hears once: the run's report joins the notice when it goes to owner too
          if (record.replyTo === OWNER) text = text ? `${a.limitNotice}\n\n${text}` : a.limitNotice;
          else await toOwner(a.limitNotice);
        }
        return { text, history: { ...agentHistory(result), ...out.history } };
      },
      (result) => ({ text: formatRunResult(record, result), history: agentHistory(result) })
    );
    return { model: run.model };
  }

  /**
   * A follow-up agent pass inside an issue run's post-run (the autofix). It becomes the active
   * agent, so `claude:stop` and status see it; after a stop, no new pass starts.
   */
  const followUpAgent =
    (a: ActiveRun, model: string | null): RunAgent =>
    async ({ prompt, label }) => {
      const logPath = join(logsDir, `${a.record.runId}-${label}.log`);
      if (a.stopRequested) return { outcome: 'stopped', exitCode: null, text: '', stderr: '' };
      a.followUps ??= [];
      // no spending past the usage limit: the pass would only hit it again
      if (await usageLimit.get().catch(() => null)) return { outcome: 'limited', exitCode: null, text: '', stderr: 'the usage-limit pause is set' };
      try {
        const run = await backend.start({ prompt, preamble, cwd: a.record.workspaceRoot, ...(model ? { model, modelSource: 'label' } : {}), logPath, onProgress: trackProgress(a.record.runId) });
        a.run = run;
        a.passLogPath = logPath;
        setPhase(a, 'agent');
        a.record = { ...a.record, agentPid: run.pid };
        // re-publish with the new agent pid (the tracker's record is fixed)
        await a.tracker.finish();
        a.tracker = activeRuns.track(a.record);
        await lock.update(a.record).catch(() => {});
        const result = await run.done;
        setPhase(a, 'post-run');
        await hitUsageLimit(a, result);
        a.followUps.push({ label, outcome: result.outcome, logPath, costUsd: result.usage.costUsd, turns: result.usage.turns });
        return result;
      } catch (err) {
        setPhase(a, 'post-run');
        return { outcome: 'spawn_error', exitCode: null, text: '', stderr: errorText(err) };
      }
    };

  /**
   * The freeform preamble plus the workspaces paused by hand, which a freeform run must not change.
   * A failed lookup just leaves the note out.
   */
  async function freeformPreambleNow() {
    const note = await pausedWorkspacesNote();
    return note ? `${freeformPreamble}\n- ${note}` : freeformPreamble;
  }

  /**
   * The note telling a freeform run which workspaces are paused by hand and must not be changed, or
   * '' when none is.
   */
  async function pausedWorkspacesNote() {
    try {
      const paused = (await manualPause.list()).filter((p) => p.scope !== ALL);
      if (!paused.length) return '';
      const lines = [];
      for (const p of paused) {
        const root = workspaces ? await workspaces.resolveIssueWorkspace(p.scope).then((w) => w.root, () => null) : null;
        lines.push(`  - ${p.scope}${root ? ` (${root})` : ''}${p.reason ? `: ${p.reason}` : ''}`);
      }
      return `The owner is working by hand in these workspaces, which are paused. Don't change files, branches or commits in them, even if asked; say so in your summary instead:\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn(`could not read workspace pauses: ${errorText(err)}`);
      return '';
    }
  }

  async function startRun(cmd: Extract<QueuedRun['cmd'], { kind: 'freeform' | 'joplin' | 'more' }>, replyTo: string): Promise<StartReply> {
    let req: AgentRequest;
    if (cmd.kind !== 'more') {
      req = cmd;
    } else {
      const queued = cmd.parent;
      if ('pending' in queued) {
        // the Parent was running when this was queued: wait for it to end (it writes its history
        // row before releasing the lock), then read its session from that row
        const cur = await lock.current();
        if (cur) return { reply: `Agent is busy. ${capitalize(describeRun(cur))} is in progress. Try again later.`, started: false, refused: 'busy' };
        const resolved = await parentFromRow((await history.read()).find((r) => r.runId === queued.runId), queued.runId);
        if (typeof resolved === 'string') return { reply: resolved, started: false };
        req = { ...cmd, parent: resolved };
      } else {
        req = { ...cmd, parent: queued };
      }
    }
    const parent = req.kind === 'more' ? req.parent : null;
    const record = newRecord({
      kind: parent ? parent.kind : cmd.kind,
      label: labelFor(cmd),
      replyTo,
      workspaceRoot: parent ? parent.cwd : workspaceRoot,
      ...(parent ? { parentRunId: parent.runId, ...(parent.inferredWorkspace ? { inferredWorkspace: parent.inferredWorkspace } : {}) } : {}),
    });
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, started: false, refused: refused.why };

    try {
      let prompt;
      let source = '';
      if (req.kind === 'more') {
        const early = EARLY_END_OUTCOMES.has(req.parent.outcome ?? '') ? `Your previous run ended early (${req.parent.outcome}).\n\n` : '';
        prompt = `${early}${req.instructions}`;
        source = `, continuing "${req.parent.label}" (${formatDuration(now() - Date.parse(req.parent.endedAt))} ago)`;
      } else if (req.kind === 'joplin') {
        let note;
        try {
          note = await joplin.getNote(req.noteQuery);
        } catch (err) {
          await lock.release(record.runId);
          return { reply: `Failed to read Joplin note: ${errorText(err)}`, started: false };
        }
        if (!note.body.trim()) {
          await lock.release(record.runId);
          return { reply: `Joplin note "${note.title}" (${note.id}) is empty. Nothing to run.`, started: false };
        }
        prompt = note.body.trim();
        record.label = `Joplin note "${note.title}"`;
        source = ` from Joplin note "${note.title}"`;
      } else {
        prompt = req.prompt;
      }
      const onTouch = record.kind === 'freeform' ? inferWorkspace(record.runId) : undefined;
      // a Continuation's conversation already holds the static preamble: only the pause note is new
      const preambleNow = parent ? ((await pausedWorkspacesNote()) || undefined) : await freeformPreambleNow();
      const started = await launch(
        record,
        {
          prompt,
          preamble: preambleNow,
          cwd: record.workspaceRoot,
          ...('model' in cmd && cmd.model
            ? { model: cmd.model }
            : parent?.model
              ? { model: parent.model, modelSource: 'parent' }
              : {}),
          ...(parent ? { resume: { sessionId: parent.sessionId } } : {}),
          ...(onTouch ? { onTouch } : {}),
        },
        async (result, a) => ({ text: `${formatRunResult(record, result)}${a.requeued ? `\n${REQUEUED_NOTE}` : ''}` }),
        queuedRun(cmd, replyTo)
      );
      return { reply: `Started run ${record.runId}${source} in ${record.workspaceRoot}${modelSuffix(started.model)}.\nLog: ${record.logPath}`, started: true };
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      return { reply: `Could not start the agent: ${errorText(err)}`, started: false };
    }
  }

  /**
   * Run a scheduled job's command under the lock: no preamble, no post-run. Its output goes to the
   * job's log file (else a run log). History gets `trigger: schedule`; `owner` hears only about a
   * failure, including one to start, since nobody is waiting for the reply.
   */
  async function startJobRun(job: ScheduledJob): Promise<StartReply> {
    if (!jobs) return { reply: 'Scheduled jobs are not configured on this runner.', started: false };
    const record = newRecord({ kind: 'job', label: `scheduled job ${job.name}`, replyTo: OWNER, workspaceRoot: job.cwd, trigger: 'schedule', jobName: job.name, room: job.room });
    if (job.logFile) record.logPath = job.logFile;
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, started: false, refused: refused.why };
    // the job's output is what gets appended from here (the live log shows only that)
    const logFrom = job.logFile ? await logSize(job.logFile).catch(() => 0) : undefined;
    const usagePath = join(logsDir, `${record.runId}.usage.jsonl`);
    let run;
    try {
      run = await jobs.start({
        command: job.command,
        cwd: job.cwd,
        logPath: record.logPath,
        // the job's own env can't override the usage file
        env: { ...job.env, [USAGE_FILE_ENV]: usagePath },
        timeoutMs: job.timeoutMinutes ? job.timeoutMinutes * 60_000 : jobTimeoutMs,
      });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      const reply = `Scheduled job ${job.name} could not start: ${errorText(err)}`;
      await outbox.send({ replyTo: OWNER, runId: record.runId, text: reply }).catch((e) => logger.error('job: outbox write failed:', errorText(e)));
      return { reply, started: false };
    }
    /** The usage the job reported, whatever its outcome; {} for no file, an empty one or a read error. */
    const jobUsage = async () => {
      let text;
      try {
        text = await readUsageFile(usagePath);
      } catch (err) {
        if (!(isRecord(err) && err.code === 'ENOENT')) logger.warn(`job ${job.name}: cannot read usage file ${usagePath}:`, errorText(err));
        return {};
      }
      const usage = sumJobUsage(text, (line, why) => logger.warn(`job ${job.name}: skipped usage line (${why}): ${oneLine(line, 80)}`));
      return usage ?? {};
    };
    const jobHistory = async (result: JobResult) => ({
      trigger: 'schedule',
      jobName: job.name,
      room: job.room,
      signal: result.signal,
      ...(result.error ? { error: result.error } : {}),
      ...(await jobUsage()),
    });
    await supervise(
      record,
      run,
      'job',
      async (result) => ({ text: formatJobResult(record, result, now() - Date.parse(record.startedAt)), history: await jobHistory(result) }),
      // can't throw, so the schedule history row and a failure notice are always written
      (result) => ({
        text: result.outcome === 'success' ? null : `Scheduled job ${job.name} ended: ${result.outcome}.`,
        history: { trigger: 'schedule', jobName: job.name, room: job.room },
      }),
      logFrom == null ? {} : { logFrom },
    );
    return { reply: `Started run ${record.runId}: scheduled job ${job.name} in ${job.cwd}.\nLog: ${record.logPath}`, started: true };
  }

  /**
   * A spec run (`claude spec:<action>:…`): launch the action's session in the workspace root, then
   * check the comment it should leave. A session that finishes without it fails the run.
   */
  async function startSpecRun(cmd: Extract<QueuedRun['cmd'], { kind: 'spec' }>, replyTo: string): Promise<StartReply> {
    if (!workspaces || !specs) return { reply: 'claude spec: is not configured on this runner.', started: false };
    let ws;
    try {
      ws = await workspaces.resolveIssueWorkspace(cmd.alias);
    } catch (err) {
      return { reply: `Agent workspace: ${errorText(err)}`, started: false };
    }
    const wsPause = await manualPause.forWorkspace(ws.alias);
    if (wsPause) return { reply: `${ws.alias} is paused by hand (${describeManualPause(wsPause, now())}). Send claude:resume ${ws.alias} first.`, started: false };
    const record = newRecord({
      kind: 'spec',
      label: labelFor(cmd),
      replyTo,
      workspaceRoot: ws.root,
      workspaceAlias: ws.alias,
      issueNumber: cmd.issueNumber,
    });
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, started: false, refused: refused.why };
    const prepared = await specs.prepare(cmd);
    if (typeof prepared === 'string') {
      await lock.release(record.runId).catch(() => {});
      return { reply: prepared, started: false };
    }
    record.label = `spec ${cmd.action} ${ws.alias}#${cmd.issueNumber}${prepared.title ? ` "${oneLine(prepared.title, 50)}"` : ''}`;
    try {
      const started = await launch(
        record,
        { prompt: prepared.prompt, cwd: prepared.root },
        async (result, a) => {
          if (result.outcome !== 'success') return { text: `${formatRunResult(record, result)}${a.requeued ? `\n${REQUEUED_NOTE}` : ''}` };
          let landed;
          try {
            landed = await specs.landed(prepared);
          } catch (err) {
            landed = false;
            logger.warn(`run ${record.runId}: cannot check the spec comment:`, errorText(err));
          }
          if (landed) return { text: `${capitalize(record.label)} finished: ${specRunExpectation(prepared.action)} was posted.\n${prepared.url}\n\n${lastNonEmptyLine(result.text) || '(no final message)'}` };
          return {
            text: `${capitalize(record.label)} failed: the session finished without ${specRunExpectation(prepared.action)}: ${lastNonEmptyLine(result.text).slice(0, 300) || '(no final message)'}\n${prepared.url}\nLog: ${result.logPath}`,
            history: { outcome: 'failed' },
          };
        },
        queuedRun(cmd, replyTo)
      );
      return { reply: `Started run ${record.runId}: ${record.label}${modelSuffix(started.model)}.\nLog: ${record.logPath}`, started: true };
    } catch (err) {
      return { reply: `Could not start the agent: ${errorText(err)}`, started: false };
    }
  }

  /**
   * The one entry point for issue runs, manual (`claude issue:…`) and cron: resolve the allowlisted
   * workspace, take the lock, fetch the issue and branch in place, run the agent with the
   * implement workflow, then post-run, then one outbox message. `done` (null when nothing started)
   * settles once the run has been reported and unlocked, with the run's result, or null when post-run
   * never reported one. `refused` says the lock was held, the runner paused or (for the cron)
   * requests are queued, so nothing was tried.
   */
  async function startIssueRun({ issueNumber, alias, extraInstructions = '', replyTo, trigger = 'manual' }: { issueNumber: number; alias: string | null; extraInstructions?: string; replyTo: string; trigger?: 'manual' | 'cron' }): Promise<{ reply: string; done: Promise<IssueRunOutcome | null> | null; refused?: 'busy' | 'paused' }> {
    if (!workspaces || !issues) return { reply: 'claude issue:<n> is not configured on this runner.', done: null };
    // queued requests go first; the cron tries again on a later tick
    if (trigger === 'cron' && (await queue.length()) > 0) return { reply: 'Requests are queued.', done: null, refused: 'busy' };
    let ws;
    try {
      ws = await workspaces.resolveIssueWorkspace(alias);
    } catch (err) {
      return { reply: `Agent workspace: ${errorText(err)}`, done: null };
    }
    // not `refused`: a request for a paused workspace isn't queued, so it can't hold up the queue
    const wsPause = await manualPause.forWorkspace(ws.alias);
    if (wsPause) {
      return { reply: `${ws.alias} is paused by hand (${describeManualPause(wsPause, now())}). Send claude:resume ${ws.alias} first.`, done: null };
    }
    const record = newRecord({
      kind: 'issue',
      label: `issue ${ws.alias}#${issueNumber}`,
      replyTo,
      workspaceRoot: ws.root,
      workspaceAlias: ws.alias,
      issueNumber,
      trigger,
    });
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, done: null, refused: refused.why };

    let prep;
    try {
      prep = await issues.prepare({ issueNumber, alias: ws.alias, workspaceRoot: ws.root, extraInstructions });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      return { reply: errorText(err), done: null };
    }
    record.label = `issue ${ws.alias}#${issueNumber}${prep.issue.title ? ` "${oneLine(prep.issue.title, 50)}"` : ''}`;

    const { model: labelModel, warnings: modelWarnings } = modelFromLabels(prep.labels);
    const warned = modelWarnings.length ? `\n${modelWarnings.join('\n')}` : '';

    let outcome: IssueRunOutcome | null = null;
    let started;
    // the cron retries on its own after the reset
    const retry = trigger === 'manual' ? queuedRun({ kind: 'issue', issueNumber, alias, extraInstructions }, replyTo) : undefined;
    try {
      started = await launch(record, { prompt: prep.prompt, implement: true, cwd: ws.root, ...(labelModel ? { model: labelModel, modelSource: 'label' } : {}) }, async (agent, a) => {
        const fin = await issues.finish({
          repo: ws.root,
          prompt: prep.prompt,
          issue: prep.issue,
          agent,
          preAgentHeadSha: prep.preAgentHeadSha,
          logPath: record.logPath,
          runAgent: followUpAgent(a, labelModel),
          trigger,
          requeued: Boolean(a.requeued),
        });
        outcome = { result: fin.result, mergeNetworkError: fin.mergeNetworkError };
        const followUps = a.followUps ?? [];
        const costs = [agent.usage.costUsd, ...followUps.map((f) => f.costUsd)].filter((c) => c != null);
        // a claude:stop or the usage limit that cut the autofix short (or kept it from starting)
        // ends the run that way, whatever the first pass did
        const cutShort = followUps.some((f) => f.outcome === 'stopped')
          ? 'stopped'
          : fin.result === 'limited' || followUps.some((f) => f.outcome === 'limited')
            ? 'limited'
            : null;
        return {
          // cron stays quiet about runs that changed nothing
          text: trigger === 'cron' && fin.silent ? null : `${fin.message}${warned}`,
          history: {
            ...(cutShort ? { outcome: cutShort } : {}),
            trigger,
            issueNumber,
            issueRepo: prep.issue.repo,
            workspaceAlias: ws.alias,
            branch: prep.branchName,
            result: fin.result,
            prUrl: prUrlOf(fin.post),
            followUps,
            // the whole run's spend, autofix included (per-pass costs stay in followUps)
            costUsd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
          },
        };
      }, retry);
    } catch (err) {
      return { reply: `Could not start the agent: ${errorText(err)}`, done: null };
    }
    const title = prep.issue.title ? ` (${prep.issue.title})` : '';
    return {
      reply: `Started run ${record.runId}: issue #${prep.issue.number}${title} in ${ws.alias} on \`${prep.branchName}\`${prep.resumed ? ', resuming earlier work' : ''}${modelSuffix(started.model)}.${warned}\nLog: ${record.logPath}`,
      done: settled.then(() => outcome),
    };
  }

  /** The PR a post-run opened or found, if any. */
  const prUrlOf = (post: PostRunResult | null | undefined) => (post?.prResult?.ok ? (post.prResult.url ?? null) : null);

  /**
   * WIP-commit an interrupted issue run's leftover work. Returns the sentence for the report.
   */
  async function recoverIssueWork(rec: RunRecord) {
    if (!issues || !rec.workspaceRoot || !rec.issueNumber) return '';
    const again = `claude issue:${rec.workspaceAlias ? `${rec.workspaceAlias}:` : ''}${rec.issueNumber}`;
    try {
      const r = await issues.commitInterruptedWork({ repo: rec.workspaceRoot, issueNumber: rec.issueNumber });
      if (r.ok) return `\nIts leftover work is committed as WIP \`${r.sha}\` on \`${r.branch}\`. Send \`${again}\` to resume.`;
      if (r.reason === 'clean') return `\nNothing was left uncommitted. Send \`${again}\` to resume.`;
      if (r.reason === 'not_issue_branch') {
        return `\n${rec.workspaceRoot} has uncommitted changes on \`${r.branch}\`, which is not the issue branch, so nothing was committed. Check it by hand.`;
      }
      return `\nCommitting its leftover work failed (${r.error}). Check ${rec.workspaceRoot} by hand.`;
    } catch (err) {
      logger.error(`recovery of ${rec.runId}: WIP commit failed:`, errorText(err));
      return `\nCommitting its leftover work failed (${errorText(err)}). Check ${rec.workspaceRoot} by hand.`;
    }
  }

  /**
   * Start a run request now. `refused` means it couldn't take the lock (busy or paused).
   */
  async function startCommand(cmd: QueuedRun['cmd'], replyTo: string): Promise<StartReply> {
    if (cmd.kind === 'job') return startJobRun(cmd.job);
    if (cmd.kind === 'spec') return startSpecRun(cmd, replyTo);
    if (cmd.kind !== 'issue') return startRun(cmd, replyTo);
    const r = await startIssueRun({ ...cmd, replyTo });
    return { reply: r.reply, started: r.done != null, ...(r.refused ? { refused: r.refused } : {}) };
  }

  const labelFor = (cmd: QueuedRun['cmd']) =>
    cmd.kind === 'freeform'
      ? oneLine(cmd.prompt, 60)
      : cmd.kind === 'more'
        ? `↪ ${oneLine(cmd.instructions, 58)}`
        : cmd.kind === 'joplin'
        ? `joplin:${cmd.noteQuery}`
        : cmd.kind === 'job'
          ? `scheduled job ${cmd.job.name}`
          : cmd.kind === 'spec'
            ? `spec ${cmd.action} ${cmd.alias ? `${cmd.alias}#` : '#'}${cmd.issueNumber}`
            : `issue ${cmd.alias ? `${cmd.alias}#` : '#'}${cmd.issueNumber}`;

  const queuedRun = (cmd: QueuedRun['cmd'], replyTo: string): QueuedRun => ({ id: randomUUID(), cmd, replyTo, label: labelFor(cmd), queuedAt: new Date(now()).toISOString() });

  /**
   * A run request (from a user, or a due scheduled job): start it now if nothing is ahead of it,
   * else queue it. `accepted` is false only when the queue was full.
   */
  async function submit(cmd: QueuedRun['cmd'], replyTo: string): Promise<{ reply: string; accepted: boolean }> {
    if ((await queue.length()) === 0) {
      const r = await startCommand(cmd, replyTo);
      if (!r.refused) return { reply: r.reply, accepted: true };
    }
    const item = queuedRun(cmd, replyTo);
    const { label } = item;
    const pos = await queue.push(item);
    if (pos == null) return { reply: `The queue is full (${queue.maxLength} waiting). Try again later, or send claude:queue clear.`, accepted: false };
    let ahead = '';
    const paused = await pausedReason();
    if (paused) {
      ahead = ` agent-runner is paused (${paused}).`;
    } else {
      const cur = await lock.current();
      if (cur) ahead = ` ${capitalize(describeRun(cur))} is in progress.`;
    }
    // in case the runner went idle between the start attempt and the push
    drainQueue();
    return { reply: `Queued (position ${pos}): ${label}.${ahead} It will start when the runs ahead of it finish.`, accepted: true };
  }

  /**
   * Start queued requests, oldest first, until one is running (or the queue is empty, or the runner
   * is busy or paused). Called when a run finishes, on startup and on a timer, which picks the
   * queue back up after a pause ends. Each request's "started" (or failure) reply goes to the outbox.
   */
  function drainQueue() {
    if (draining) return draining;
    draining = (async () => {
      try {
        for (;;) {
          if ((await pausedReason()) || (await lock.current())) return;
          const item = await queue.shift();
          if (!item) return;
          const r = await startCommand(item.cmd, item.replyTo);
          if (r.refused) {
            await queue.unshift(item);
            return;
          }
          // a job reports only its own failures (startJobRun, and its run's report)
          if (item.cmd.kind === 'job') {
            if (r.started) return;
            continue;
          }
          const text = r.started ? `Queued request "${item.label}": ${r.reply}` : `Queued request "${item.label}" did not start: ${r.reply}`;
          await outbox.send({ replyTo: item.replyTo, text }).catch((err) => logger.error('queue: outbox write failed:', errorText(err)));
          if (r.started) return;
        }
      } catch (err) {
        logger.error('queue: drain failed:', errorText(err));
      } finally {
        draining = null;
      }
    })();
    lastDrain = draining;
    return draining;
  }

  /**
   * The active freeform or Joplin run as a pending Parent, when `claude:more` (with no run prefix,
   * or one that matches it) should continue it rather than a row from history. Null for an issue
   * run or job, or when nothing is active: the history picks apply then.
   */
  async function runningParent(runRef?: string): Promise<ContinuationParent | null> {
    const cur = await lock.current();
    if (!cur || (cur.kind !== 'freeform' && cur.kind !== 'joplin')) return null;
    if (runRef && !cur.runId.startsWith(runRef)) return null;
    return { runId: cur.runId, kind: cur.kind, label: cur.label ?? cur.runId, cwd: cur.workspaceRoot ?? workspaceRoot, pending: true };
  }

  /**
   * The Parent run for a `claude:more`: the newest freeform or Joplin run in history, whatever its
   * outcome. A refusal's one line when there is none or it can't be resumed.
   * @param runRef a run-id prefix. Continue that run instead.
   */
  async function pickParent(runRef?: string): Promise<ContinuationParent | string> {
    const rows = await history.read();
    let row;
    if (runRef) {
      const hits = rows.filter((r) => r.runId.startsWith(runRef));
      const matches = hits.filter((r) => r.runId === runRef);
      if (matches.length !== 1 && hits.length !== 1) {
        return hits.length ? `Run prefix "${runRef}" is ambiguous: it matches ${hits.length} runs.` : `No run in history matches "${runRef}".`;
      }
      row = matches[0] ?? hits[0];
      if (row.kind === 'issue') {
        const target = row.workspaceAlias && row.issueNumber ? `issue:${row.workspaceAlias}:${row.issueNumber}` : 'issue:<alias>:<n>';
        return `Run ${row.runId} is an issue run: use claude ${target} <extra instructions> to continue it.`;
      }
      if (row.kind === 'job') return `Cannot continue run ${row.runId}: it is a scheduled job.`;
    } else {
      row = rows.find((r) => r.kind === 'freeform' || r.kind === 'joplin');
    }
    return parentFromRow(row);
  }

  /** `pendingRunId` is set when the row is a still-running Parent's, which may be missing. */
  function parentFromRow(row: HistoryEntry | undefined, pendingRunId?: string): ResolvedParent | string {
    if (!row) return pendingRunId ? `Cannot continue run ${pendingRunId}: it left no history row, so there is no session to resume.` : 'Nothing to continue: no freeform or Joplin run in history.';
    if (row.kind !== 'freeform' && row.kind !== 'joplin') return `Cannot continue run ${row.runId}: only freeform and Joplin runs can be continued.`;
    if (typeof row.sessionId !== 'string' || !row.sessionId) return `Cannot continue "${row.label ?? row.runId}": that run has no recorded session.`;
    return {
      runId: row.runId,
      kind: row.kind,
      label: row.label ?? row.runId,
      sessionId: row.sessionId,
      cwd: typeof row.workspaceRoot === 'string' ? row.workspaceRoot : workspaceRoot,
      endedAt: row.endedAt,
      outcome: row.outcome,
      ...(typeof row.model === 'string' && row.model ? { model: row.model } : {}),
      ...(typeof row.inferredWorkspace === 'string' ? { inferredWorkspace: row.inferredWorkspace } : {}),
    };
  }

  /**
   * Add a `claude:more` message to a Continuation of the same Parent already waiting in the queue,
   * so one agent gets both texts in order. Null when none is waiting.
   * @param replyTo only the same sender's waiting request is added to, since its report goes to them
   * @param model a model prefix on this message replaces the queued request's model
   * @returns the reply
   */
  async function addToQueuedContinuation(parentRunId: string, instructions: string, replyTo: string, model?: string): Promise<string | null> {
    const waiting = (await queue.list()).find((it) => it.cmd.kind === 'more' && it.cmd.parent.runId === parentRunId && it.replyTo === replyTo);
    if (!waiting) return null;
    const updated = await queue.update(waiting.id, (it) =>
      it.cmd.kind === 'more' ? { ...it, cmd: { ...it.cmd, instructions: `${it.cmd.instructions}\n\n---\n\n${instructions}`, ...(model ? { model } : {}) } } : it
    );
    if (!updated) return null;
    return `Added to the queued Continuation of run ${parentRunId} (position ${updated.position}): ${waiting.label}. It will start when the runs ahead of it finish.`;
  }

  async function queueCommand(clear: boolean) {
    const items = await queue.list();
    if (clear) {
      await queue.clear();
      return items.length ? `Dropped ${items.length} queued request${items.length === 1 ? '' : 's'}.` : 'The queue is already empty.';
    }
    if (!items.length) return 'The queue is empty.';
    return [`Queued (${items.length}):`, ...items.map((it, i) => `${i + 1}. ${it.label}`)].join('\n');
  }

  async function stop() {
    if (active) {
      active.stopRequested = true;
      if (active.phase === 'post-run') {
        return `Run ${active.record.runId} is past the agent, in post-run (commit, PR, review, merge), which can't be interrupted. No further agent pass will start. Its report will follow.`;
      }
      active.run.stop();
      if (active.phase === 'job') return `Stopping run ${active.record.runId} (${active.record.label}). Its report will follow.`;
      return `Stopping run ${active.record.runId}. Its report will follow.`;
    }
    const cur = await lock.current();
    if (cur) return `Run ${cur.runId} holds the lock but is not running in this process, so there is nothing to stop.`;
    return 'Nothing is running.';
  }

  async function restart(replyTo: string) {
    const d = decideSafeRestart({ activeRun: await lock.current(), pause: await pause.get() });
    if ('reason' in d) return `safe-restart refused: ${d.reason}`;
    launchSafeRestart(replyTo);
    return 'Restarting agent-runner. I will report back when it is up.';
  }

  return {
    async handleCommand({ text, replyTo }: { text: string; replyTo: string }): Promise<{ reply: string }> {
      const cmd = parseCommand(text);
      switch (cmd.kind) {
        case 'error':
          return { reply: cmd.message };
        case 'stop':
          return { reply: await stop() };
        case 'restart':
          return { reply: await restart(replyTo) };
        case 'queue':
          return { reply: await queueCommand(cmd.clear) };
        case 'pause':
          return { reply: (await applyPauseCommand({ manualPause, usageLimit, workspaces, cmd, now })).reply };
        case 'resume': {
          const { reply } = await applyPauseCommand({ manualPause, usageLimit, workspaces, cmd, now });
          drainQueue();
          return { reply };
        }
        case 'more': {
          const running = await runningParent(cmd.runRef);
          const parent = running ?? (await pickParent(cmd.runRef));
          if (typeof parent === 'string') return { reply: parent };
          const merged = await addToQueuedContinuation(parent.runId, cmd.instructions, replyTo, cmd.model);
          if (merged) return { reply: merged };
          const { reply } = await submit({ kind: 'more', instructions: cmd.instructions, parent, ...(cmd.model ? { model: cmd.model } : {}) }, replyTo);
          return { reply: running ? `Continuing run ${running.runId} ("${running.label}"), which is still running. ${reply}` : reply };
        }
        case 'spec': {
          if (!specs) return { reply: 'claude spec: is not configured on this runner.' };
          if (cmd.action === 'reject') return { reply: await specs.reject(cmd) };
          // the queued run checks the spec precondition once, when it starts
          return { reply: (await submit({ kind: 'spec', action: cmd.action, issueNumber: cmd.issueNumber, alias: cmd.alias, notes: cmd.notes }, replyTo)).reply };
        }
        case 'status':
          return { reply: renderStatusText(await statusSnapshot()) };
        case 'history':
          return { reply: renderHistoryText(await history.read({ limit: cmd.count }), now()) };
        default:
          return { reply: (await submit(cmd, replyTo)).reply };
      }
    },

    async status(): Promise<{ busy: boolean; activeRun: (RunRecord & Partial<AgentProgress> & { phase?: ActiveRun['phase'] }) | null; paused: boolean; queued: number }> {
      const [held, paused, queued] = await Promise.all([lock.current(), pausedReason(), queue.length()]);
      const live = active && held?.runId === active.record.runId ? { ...active.progress, phase: active.phase } : null;
      return {
        busy: Boolean(held),
        activeRun: held ? { ...held, ...(live ?? {}) } : null,
        paused: Boolean(paused),
        queued,
      };
    },

    /**
     * The run this process is executing and the log it is writing now (an autofix pass's own log
     * once that starts), for the office feed's live tail. Null when idle.
     */
    activeLog(): ActiveLog | null {
      if (!active?.record.logPath) return null;
      const log = { runId: active.record.runId, logPath: active.passLogPath ?? active.record.logPath };
      return active.logFrom == null ? log : { ...log, fromByte: active.logFrom };
    },

    /**
     * On startup, any lock is left over from a previous process (the HTTP port is bound first, so
     * no other runner is alive): tell `owner`, then free the lock. The pause flag is not ours to clear.
     */
    async recoverInterruptedRun() {
      const rec = await lock.current();
      if (!rec) return null;
      const isJob = rec.kind === 'job';
      const name = isJob ? capitalize(describeRun(rec)) : `Agent ${describeRun(rec)}`;
      const pid = rec.agentPid || null;
      let agentAlive = false;
      let orphan = '';
      if (pid != null && isAlive(pid)) {
        agentAlive = true;
        if (isJob) {
          // not an agent, so the agent's orphan check doesn't apply; left alone, but said
          orphan = `\nIts process (pid ${pid}) is still running, but nobody will report its result.`;
        } else {
          // nobody will report it, and a re-run must not share the repo with it
          agentAlive = !(await stopOrphanAgent(pid).catch(() => false));
          orphan = agentAlive
            ? `\nIts agent process (pid ${pid}) is still running, but nobody will report its result.`
            : `\nIts agent process (pid ${pid}) outlived the runner and has been stopped.`;
        }
      }
      // an issue run's leftover work is WIP-committed so a re-run resumes it (never while its agent
      // may still be writing)
      const wip = rec.kind === 'issue' && !agentAlive ? await recoverIssueWork(rec) : '';
      const log = rec.logPath ? `\nLog: ${rec.logPath}` : '';
      await outbox.send({
        replyTo: OWNER,
        runId: rec.runId === UNKNOWN_RUN_ID ? '' : rec.runId,
        text: `${name} was interrupted: agent-runner restarted before it finished.${orphan}${wip}${log}`,
      });
      // so the office shows it in its room, as it does every other finished run
      if (rec.runId !== UNKNOWN_RUN_ID) {
        const endedAt = now();
        const startedMs = rec.startedAt ? Date.parse(rec.startedAt) : NaN;
        await history
          .append({
            runId: rec.runId,
            kind: rec.kind,
            label: rec.label,
            trigger: rec.trigger,
            workspaceAlias: rec.workspaceAlias,
            inferredWorkspace: rec.inferredWorkspace,
            parentRunId: rec.parentRunId,
            issueNumber: rec.issueNumber,
            room: rec.room,
            jobName: rec.jobName,
            replyTo: rec.replyTo,
            workspaceRoot: rec.workspaceRoot,
            logPath: rec.logPath,
            startedAt: rec.startedAt,
            endedAt: new Date(endedAt).toISOString(),
            ...(Number.isFinite(startedMs) ? { durationMs: endedAt - startedMs } : {}),
            outcome: 'interrupted',
          })
          .catch((err) => logger.warn(`recovery of ${rec.runId}: history write failed:`, errorText(err)));
      }
      if (rec.runId === UNKNOWN_RUN_ID) await lock.forceClear();
      else await lock.release(rec.runId);
      return rec;
    },

    startIssueRun,
    drainQueue,

    /**
     * A due scheduled job joins the run queue (or starts, if nothing is ahead of it).
     */
    submitJob: (job: ScheduledJob) => submit({ kind: 'job', job }, OWNER),

    /** Resolves once the current run (if any) has been reported and unlocked, and the queue drain it kicked off is done. */
    idle: async () => {
      await settled;
      await lastDrain;
    },
  };
}
