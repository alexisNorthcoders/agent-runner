import { randomUUID } from 'crypto';
import { join } from 'path';
import { parseCommand } from './commands.js';
import { ALL, applyPauseCommand, describeManualPause } from './manualPause.js';
import { OWNER } from './outbox.js';
import { DEFAULT_JOB_TIMEOUT_MINUTES } from './scheduledJobs.js';
import { decideSafeRestart } from './safeRestart.js';
import { describeRun, UNKNOWN_RUN_ID } from './runLock.js';
import { pidAlive } from './pidAlive.js';
import { formatDuration, renderHistoryText, renderStatusText } from './statusFormat.js';

/**
 * The runner: turns a `claude…` command into at most one agent run at a time and reports every
 * outcome through the outbox. A request that arrives while busy (or paused) waits in the run queue
 * and starts when the runs ahead of it have finished. HTTP (src/http.js) and startup (src/main.js)
 * are thin shells over it.
 */

const MAX_OUTBOX_TEXT = 30_000;
const STDERR_TAIL = 800;

/** Timestamp-based run id, safe in file names. */
export const timestampRunId = () => new Date().toISOString().replace(/[:.]/g, '-');

const oneLine = (s, n) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const cap = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}\n…(truncated, see the log)`);

/**
 * @param {import('./runLock.js').RunRecord} rec
 * @param {import('./agentBackend/index.js').AgentResult} r
 */
export function formatRunResult(rec, r) {
  const name = capitalize(describeRun(rec));
  const cost = r.usage.costUsd != null ? `, $${r.usage.costUsd.toFixed(2)}` : '';
  const logLine = `Log: ${r.logPath}`;
  const tail = r.stderr.trim() ? `\n${r.stderr.trim().slice(-STDERR_TAIL)}` : '';
  switch (r.outcome) {
    case 'success':
      return cap(`${name} finished (${r.usage.turns} turns${cost}).\n\n${r.text.trim() || '(no final message)'}`, MAX_OUTBOX_TEXT);
    case 'stopped':
      return `${name} was stopped by claude:stop.\n${logLine}`;
    case 'timeout':
      return `${name} timed out and was killed.\n${logLine}`;
    case 'spawn_error':
      return `${name} could not start the agent.${tail}`;
    default:
      return cap(`${name} failed (exit ${r.exitCode ?? 'n/a'}).${tail}\n${logLine}`, MAX_OUTBOX_TEXT);
  }
}

/**
 * A failed scheduled job's one-line report. Null for a success, which stays quiet.
 * @param {import('./runLock.js').RunRecord} rec
 * @param {import('./jobProcess.js').JobResult} r
 * @param {number} durationMs
 */
export function formatJobResult(rec, r, durationMs) {
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
 * @typedef {import('./agentBackend/index.js').AgentRun} AgentRun
 * @typedef {{
 *   record: import('./runLock.js').RunRecord,
 *   run: { pid: number | null, stop: () => void },
 *   progress: import('./agentBackend/index.js').AgentProgress | null,
 *   phase: 'agent' | 'post-run' | 'job',
 *   stopRequested: boolean,
 *   tracker: ReturnType<ReturnType<typeof import('./activeRuns.js').createActiveRuns>['track']>,
 *   followUps?: Array<{ label: string, outcome: string, logPath: string, costUsd: number | null, turns: number }>,
 * }} ActiveRun
 */

/**
 * How an issue run ended, for the cron: its result, and whether an approved PR's merge failed only
 * on a network error (so the cron works the PR again instead of setting it aside).
 * @typedef {{ result: import('./issuePipeline/index.js').IssueRunResult, mergeNetworkError: boolean }} IssueRunOutcome
 */

/**
 * @param {{
 *   lock: ReturnType<typeof import('./runLock.js').createRunLock>,
 *   pause: ReturnType<typeof import('./pauseFlag.js').createPauseFlag>,
 *   manualPause: ReturnType<typeof import('./manualPause.js').createManualPause>,
 *   queue: ReturnType<typeof import('./runQueue.js').createRunQueue>,
 *   outbox: ReturnType<typeof import('./outbox.js').createOutbox>,
 *   backend: import('./agentBackend/index.js').AgentBackend,
 *   history: Pick<ReturnType<typeof import('./runHistory.js').createRunHistory>, 'append' | 'read'>,
 *   activeRuns: Pick<ReturnType<typeof import('./activeRuns.js').createActiveRuns>, 'track'>,
 *   statusSnapshot: () => Promise<import('./statusCollect.js').StatusSnapshot>,
 *   joplin: { getNote: (query: string) => Promise<{ id: string, title: string, body: string }> },
 *   launchSafeRestart: (replyTo: string) => void,
 *   workspaces?: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }> },
 *   issues?: Pick<import('./issuePipeline/index.js').IssuePipeline, 'prepare' | 'finish' | 'commitInterruptedWork'>,
 *   jobs?: Pick<import('./jobProcess.js').JobLauncher, 'start'>,
 *   jobTimeoutMs?: number,
 *   workspaceRoot: string,
 *   logsDir: string,
 *   preamble: string,
 *   freeformPreamble?: string,
 *   newRunId?: () => string,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 *   stopOrphanAgent?: (pid: number) => Promise<boolean>,
 *   logger?: Pick<Console, 'error' | 'warn' | 'info'>,
 *   onChange?: import('./stateChanges.js').NotifyChange,
 * }} deps
 *   `onChange` is told about state that lives only here or in files (progress, phase, the run
 *   starting and finishing); Redis state tells it through its store (src/stateChanges.js).
 */
export function createRunner({
  lock,
  pause,
  manualPause,
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
  logger = console,
  onChange = () => {},
}) {
  /** The run this process is executing, if any. @type {ActiveRun | null} */
  let active = null;
  /** Settles when the active run has been reported and its lock released. */
  let settled = Promise.resolve();
  /** The latest queue drain; one runs at a time. */
  let draining = /** @type {Promise<void> | null} */ (null);
  let lastDrain = Promise.resolve();

  /** @param {string} runId */
  const trackProgress = (runId) => (p) => {
    if (active?.record.runId !== runId) return;
    active.progress = p;
    active.tracker.update(p);
    onChange('progress');
  };

  /** @param {ActiveRun} a @param {ActiveRun['phase']} phase */
  const setPhase = (a, phase) => {
    a.phase = phase;
    onChange('phase');
  };

  /**
   * Why no run may start now: the safe-restart pause or the owner's general pause. Null when neither is set.
   * @returns {Promise<string | null>}
   */
  async function pausedReason() {
    const restarting = await pause.get();
    if (restarting) return restarting.reason;
    const byHand = await manualPause.general();
    return byHand ? `paused by hand: ${describeManualPause(byHand, now())}` : null;
  }

  /**
   * Take the single-flight lock for `record`. Returns why it wasn't taken (with the reply), or null
   * once it's held.
   * @param {import('./runLock.js').RunRecord} record
   * @returns {Promise<{ why: 'busy' | 'paused', reply: string } | null>}
   */
  async function acquire(record) {
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

  /**
   * @param {{ kind: string, label: string, replyTo: string, workspaceRoot: string } & Partial<import('./runLock.js').RunRecord>} p
   * @returns {import('./runLock.js').RunRecord}
   */
  function newRecord(p) {
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
   * @template R
   * @param {import('./runLock.js').RunRecord} record
   * @param {{ pid: number | null, done: Promise<R & { outcome: string, exitCode: number | null }>, stop: () => void }} run
   * @param {'agent' | 'job'} phase
   * @param {(result: R & { outcome: string, exitCode: number | null }, a: ActiveRun) => Promise<{ text: string | null, history?: object }>} report
   * @param {(result: R & { outcome: string, exitCode: number | null }) => { text: string | null, history?: object }} fallback
   */
  async function supervise(record, run, phase, report, fallback) {
    const { runId } = record;
    const running = { ...record, agentPid: run.pid };
    /** @type {ActiveRun} */
    const a = { record: running, run, progress: null, phase, stopRequested: false, tracker: activeRuns.track(running) };
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
          await outbox.send({ replyTo: /** @type {string} */ (record.replyTo), runId, text: out.text });
        } catch (err) {
          logger.error(`run ${runId}: outbox write failed:`, err?.message || err);
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
          durationMs: endedAt - Date.parse(/** @type {string} */ (record.startedAt)),
          outcome: result.outcome,
          exitCode: result.exitCode,
          ...out.history,
        });
      } catch (err) {
        logger.warn(`run ${runId}: history write failed:`, err?.message || err);
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
          logger.error(`run ${runId}: lock release failed (expires on its own):`, err?.message || err);
        }
        drainQueue();
      });
    return a;
  }

  /**
   * Start the agent for a run that holds the lock, then report in the background (`supervise`):
   * `report` turns the agent's result into the outbox text and extra history fields. Releases the
   * lock if the agent can't start.
   * @param {import('./runLock.js').RunRecord} record
   * @param {Omit<import('./agentBackend/index.js').AgentStartOptions, 'logPath' | 'onProgress'>} opts
   *   `preamble` defaults to the issue-run preamble.
   * @param {(result: import('./agentBackend/index.js').AgentResult, a: ActiveRun) => Promise<{ text: string | null, history?: object }>} report
   */
  async function launch(record, opts, report) {
    let run;
    try {
      run = await backend.start({ preamble, ...opts, logPath: /** @type {string} */ (record.logPath), onProgress: trackProgress(record.runId) });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      throw err;
    }
    /** @param {import('./agentBackend/index.js').AgentResult} result */
    const agentHistory = (result) => ({ backend: backend.name, logPath: result.logPath, ...result.usage });
    return supervise(
      record,
      run,
      'agent',
      async (result, a) => {
        const out = await report(result, a);
        return { text: out.text, history: { ...agentHistory(result), ...out.history } };
      },
      (result) => ({ text: formatRunResult(record, result), history: agentHistory(result) })
    );
  }

  /**
   * A follow-up agent pass inside an issue run's post-run (the autofix). It becomes the active
   * agent, so `claude:stop` and status see it; after a stop, no new pass starts.
   * @param {ActiveRun} a
   * @returns {import('./issuePipeline/postRun.js').RunAgent}
   */
  const followUpAgent =
    (a) =>
    async ({ prompt, label }) => {
      const logPath = join(logsDir, `${a.record.runId}-${label}.log`);
      if (a.stopRequested) return { outcome: 'stopped', exitCode: null, text: '', stderr: '' };
      a.followUps ??= [];
      try {
        const run = await backend.start({ prompt, preamble, cwd: a.record.workspaceRoot, logPath, onProgress: trackProgress(a.record.runId) });
        a.run = run;
        setPhase(a, 'agent');
        a.record = { ...a.record, agentPid: run.pid };
        // re-publish with the new agent pid (the tracker's record is fixed)
        await a.tracker.finish();
        a.tracker = activeRuns.track(a.record);
        await lock.update(a.record).catch(() => {});
        const result = await run.done;
        setPhase(a, 'post-run');
        a.followUps.push({ label, outcome: result.outcome, logPath, costUsd: result.usage.costUsd, turns: result.usage.turns });
        return result;
      } catch (err) {
        setPhase(a, 'post-run');
        return { outcome: 'spawn_error', exitCode: null, text: '', stderr: err?.message || String(err) };
      }
    };

  /**
   * The freeform preamble plus the workspaces paused by hand, which a freeform run must not change.
   * A failed lookup just leaves the note out.
   */
  async function freeformPreambleNow() {
    try {
      const paused = (await manualPause.list()).filter((p) => p.scope !== ALL);
      if (!paused.length) return freeformPreamble;
      const lines = [];
      for (const p of paused) {
        const root = workspaces ? await workspaces.resolveIssueWorkspace(p.scope).then((w) => w.root, () => null) : null;
        lines.push(`  - ${p.scope}${root ? ` (${root})` : ''}${p.reason ? `: ${p.reason}` : ''}`);
      }
      return `${freeformPreamble}\n- The owner is working by hand in these workspaces, which are paused. Don't change files, branches or commits in them, even if asked; say so in your summary instead:\n${lines.join('\n')}`;
    } catch (err) {
      logger.warn(`could not read workspace pauses: ${err?.message || err}`);
      return freeformPreamble;
    }
  }

  /**
   * @param {{ kind: 'freeform', prompt: string } | { kind: 'joplin', noteQuery: string }} cmd
   * @param {string} replyTo
   * @returns {Promise<{ reply: string, started: boolean, refused?: 'busy' | 'paused' }>}
   */
  async function startRun(cmd, replyTo) {
    const record = newRecord({
      kind: cmd.kind,
      label: cmd.kind === 'freeform' ? oneLine(cmd.prompt, 60) : `joplin:${cmd.noteQuery}`,
      replyTo,
      workspaceRoot,
    });
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, started: false, refused: refused.why };

    try {
      let prompt;
      let source = '';
      if (cmd.kind === 'joplin') {
        let note;
        try {
          note = await joplin.getNote(cmd.noteQuery);
        } catch (err) {
          await lock.release(record.runId);
          return { reply: `Failed to read Joplin note: ${err?.message || err}`, started: false };
        }
        if (!note.body.trim()) {
          await lock.release(record.runId);
          return { reply: `Joplin note "${note.title}" (${note.id}) is empty. Nothing to run.`, started: false };
        }
        prompt = note.body.trim();
        record.label = `Joplin note "${note.title}"`;
        source = ` from Joplin note "${note.title}"`;
      } else {
        prompt = cmd.prompt;
      }
      await launch(record, { prompt, preamble: await freeformPreambleNow(), cwd: workspaceRoot }, async (result) => ({ text: formatRunResult(record, result) }));
      return { reply: `Started run ${record.runId}${source} in ${workspaceRoot}.\nLog: ${record.logPath}`, started: true };
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      return { reply: `Could not start the agent: ${err?.message || err}`, started: false };
    }
  }

  /**
   * Run a scheduled job's command under the lock: no preamble, no post-run. Its output goes to the
   * job's log file (else a run log). History gets `trigger: schedule`; `owner` hears only about a
   * failure, including one to start, since nobody is waiting for the reply.
   * @param {import('./scheduledJobs.js').ScheduledJob} job
   * @returns {Promise<{ reply: string, started: boolean, refused?: 'busy' | 'paused' }>}
   */
  async function startJobRun(job) {
    if (!jobs) return { reply: 'Scheduled jobs are not configured on this runner.', started: false };
    const record = newRecord({ kind: 'job', label: `scheduled job ${job.name}`, replyTo: OWNER, workspaceRoot: job.cwd, trigger: 'schedule', jobName: job.name, room: job.room });
    if (job.logFile) record.logPath = job.logFile;
    const refused = await acquire(record);
    if (refused) return { reply: refused.reply, started: false, refused: refused.why };
    let run;
    try {
      run = await jobs.start({
        command: job.command,
        cwd: job.cwd,
        logPath: /** @type {string} */ (record.logPath),
        env: job.env,
        timeoutMs: job.timeoutMinutes ? job.timeoutMinutes * 60_000 : jobTimeoutMs,
      });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      const reply = `Scheduled job ${job.name} could not start: ${err?.message || err}`;
      await outbox.send({ replyTo: OWNER, runId: record.runId, text: reply }).catch((e) => logger.error('job: outbox write failed:', e?.message || e));
      return { reply, started: false };
    }
    /** @param {import('./jobProcess.js').JobResult} result */
    const report = (result) => ({
      text: formatJobResult(record, result, now() - Date.parse(/** @type {string} */ (record.startedAt))),
      history: { trigger: 'schedule', jobName: job.name, room: job.room, signal: result.signal, ...(result.error ? { error: result.error } : {}) },
    });
    await supervise(record, run, 'job', async (result) => report(result), report);
    return { reply: `Started run ${record.runId}: scheduled job ${job.name} in ${job.cwd}.\nLog: ${record.logPath}`, started: true };
  }

  /**
   * The one entry point for issue runs, manual (`claude issue:…`) and cron: resolve the allowlisted
   * workspace, take the lock, fetch the issue and branch in place, run the agent with the
   * implement workflow, then post-run, then one outbox message.
   * @param {{ issueNumber: number, alias: string | null, extraInstructions?: string, replyTo: string, trigger?: 'manual' | 'cron' }} p
   * @returns {Promise<{ reply: string, done: Promise<IssueRunOutcome | null> | null, refused?: 'busy' | 'paused' }>}
   *   `done` (null when nothing started) settles once the run has been reported and unlocked, with
   *   the run's result, or null when post-run never reported one.
   *   `refused` says the lock was held, the runner paused or (for the cron) requests are queued, so
   *   nothing was tried.
   */
  async function startIssueRun({ issueNumber, alias, extraInstructions = '', replyTo, trigger = 'manual' }) {
    if (!workspaces || !issues) return { reply: 'claude issue:<n> is not configured on this runner.', done: null };
    // queued requests go first; the cron tries again on a later tick
    if (trigger === 'cron' && (await queue.length()) > 0) return { reply: 'Requests are queued.', done: null, refused: 'busy' };
    let ws;
    try {
      ws = await workspaces.resolveIssueWorkspace(alias);
    } catch (err) {
      return { reply: `Agent workspace: ${err?.message || err}`, done: null };
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
      return { reply: err?.message || String(err), done: null };
    }
    record.label = `issue ${ws.alias}#${issueNumber}${prep.issue.title ? ` "${oneLine(prep.issue.title, 50)}"` : ''}`;

    /** @type {IssueRunOutcome | null} */
    let outcome = null;
    try {
      await launch(record, { prompt: prep.prompt, implement: true, cwd: ws.root }, async (agent, a) => {
        const fin = await issues.finish({
          repo: ws.root,
          prompt: prep.prompt,
          issue: prep.issue,
          agent,
          preAgentHeadSha: prep.preAgentHeadSha,
          logPath: record.logPath,
          runAgent: followUpAgent(a),
          trigger,
        });
        outcome = { result: fin.result, mergeNetworkError: fin.mergeNetworkError };
        const followUps = a.followUps ?? [];
        const costs = [agent.usage.costUsd, ...followUps.map((f) => f.costUsd)].filter((c) => c != null);
        return {
          // cron stays quiet about runs that changed nothing
          text: trigger === 'cron' && fin.silent ? null : fin.message,
          history: {
            trigger,
            issueNumber,
            issueRepo: prep.issue.repo,
            workspaceAlias: ws.alias,
            branch: prep.branchName,
            result: fin.result,
            followUps,
            // the whole run's spend, autofix included (per-pass costs stay in followUps)
            costUsd: costs.length ? costs.reduce((x, y) => x + y, 0) : null,
          },
        };
      });
    } catch (err) {
      return { reply: `Could not start the agent: ${err?.message || err}`, done: null };
    }
    const title = prep.issue.title ? ` (${prep.issue.title})` : '';
    return {
      reply: `Started run ${record.runId}: issue #${prep.issue.number}${title} in ${ws.alias} on \`${prep.branchName}\`${prep.resumed ? ', resuming earlier work' : ''}.\nLog: ${record.logPath}`,
      done: settled.then(() => outcome),
    };
  }

  /**
   * WIP-commit an interrupted issue run's leftover work. Returns the sentence for the report.
   * @param {import('./runLock.js').RunRecord} rec
   */
  async function recoverIssueWork(rec) {
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
      logger.error(`recovery of ${rec.runId}: WIP commit failed:`, err?.message || err);
      return `\nCommitting its leftover work failed (${err?.message || err}). Check ${rec.workspaceRoot} by hand.`;
    }
  }

  /**
   * Start a run request now. `refused` means it couldn't take the lock (busy or paused).
   * @param {import('./runQueue.js').QueuedRun['cmd']} cmd
   * @param {string} replyTo
   * @returns {Promise<{ reply: string, started: boolean, refused?: 'busy' | 'paused' }>}
   */
  async function startCommand(cmd, replyTo) {
    if (cmd.kind === 'job') return startJobRun(cmd.job);
    if (cmd.kind !== 'issue') return startRun(cmd, replyTo);
    const r = await startIssueRun({ ...cmd, replyTo });
    return { reply: r.reply, started: r.done != null, ...(r.refused ? { refused: r.refused } : {}) };
  }

  /** @param {import('./runQueue.js').QueuedRun['cmd']} cmd */
  const labelFor = (cmd) =>
    cmd.kind === 'freeform'
      ? oneLine(cmd.prompt, 60)
      : cmd.kind === 'joplin'
        ? `joplin:${cmd.noteQuery}`
        : cmd.kind === 'job'
          ? `scheduled job ${cmd.job.name}`
          : `issue ${cmd.alias ? `${cmd.alias}#` : '#'}${cmd.issueNumber}`;

  /**
   * A run request (from a user, or a due scheduled job): start it now if nothing is ahead of it,
   * else queue it. `accepted` is false only when the queue was full.
   * @param {import('./runQueue.js').QueuedRun['cmd']} cmd
   * @param {string} replyTo
   * @returns {Promise<{ reply: string, accepted: boolean }>}
   */
  async function submit(cmd, replyTo) {
    let why = 'busy';
    if ((await queue.length()) === 0) {
      const r = await startCommand(cmd, replyTo);
      if (!r.refused) return { reply: r.reply, accepted: true };
      why = r.refused;
    }
    const label = labelFor(cmd);
    const pos = await queue.push({ id: randomUUID(), cmd, replyTo, label, queuedAt: new Date(now()).toISOString() });
    if (pos == null) return { reply: `The queue is full (${queue.maxLength} waiting). Try again later, or send claude:queue clear.`, accepted: false };
    let ahead = '';
    if (why === 'paused') {
      const p = await pausedReason();
      ahead = ` agent-runner is paused${p ? ` (${p})` : ''}.`;
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
          await outbox.send({ replyTo: item.replyTo, text }).catch((err) => logger.error('queue: outbox write failed:', err?.message || err));
          if (r.started) return;
        }
      } catch (err) {
        logger.error('queue: drain failed:', err?.message || err);
      } finally {
        draining = null;
      }
    })();
    lastDrain = draining;
    return draining;
  }

  /** @param {boolean} clear */
  async function queueCommand(clear) {
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

  /** @param {string} replyTo */
  async function restart(replyTo) {
    const d = decideSafeRestart({ activeRun: await lock.current(), pause: await pause.get() });
    if ('reason' in d) return `safe-restart refused: ${d.reason}`;
    launchSafeRestart(replyTo);
    return 'Restarting agent-runner. I will report back when it is up.';
  }

  return {
    /**
     * @param {{ text: string, replyTo: string }} req
     * @returns {Promise<{ reply: string }>}
     */
    async handleCommand({ text, replyTo }) {
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
          return { reply: (await applyPauseCommand({ manualPause, workspaces, cmd, now })).reply };
        case 'resume': {
          const { reply } = await applyPauseCommand({ manualPause, workspaces, cmd, now });
          drainQueue();
          return { reply };
        }
        case 'status':
          return { reply: renderStatusText(await statusSnapshot()) };
        case 'history':
          return { reply: renderHistoryText(await history.read({ limit: cmd.count }), now()) };
        default:
          return { reply: (await submit(cmd, replyTo)).reply };
      }
    },

    /** @returns {Promise<{ busy: boolean, activeRun: (import('./runLock.js').RunRecord & Partial<import('./agentBackend/index.js').AgentProgress> & { phase?: ActiveRun['phase'] }) | null, paused: boolean, queued: number }>} */
    async status() {
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
     * On startup, any lock is left over from a previous process (the HTTP port is bound first, so
     * no other runner is alive): tell `owner`, then free the lock. The pause flag is not ours to clear.
     */
    async recoverInterruptedRun() {
      const rec = await lock.current();
      if (!rec) return null;
      const isJob = rec.kind === 'job';
      const name = isJob ? capitalize(describeRun(rec)) : `Agent ${describeRun(rec)}`;
      let agentAlive = Boolean(rec.agentPid && isAlive(rec.agentPid));
      let orphan = '';
      if (agentAlive && isJob) {
        // not an agent, so the agent's orphan check doesn't apply; left alone, but said
        orphan = `\nIts process (pid ${rec.agentPid}) is still running, but nobody will report its result.`;
      } else if (agentAlive) {
        // nobody will report it, and a re-run must not share the repo with it
        agentAlive = !(await stopOrphanAgent(rec.agentPid).catch(() => false));
        orphan = agentAlive
          ? `\nIts agent process (pid ${rec.agentPid}) is still running, but nobody will report its result.`
          : `\nIts agent process (pid ${rec.agentPid}) outlived the runner and has been stopped.`;
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
      if (rec.runId === UNKNOWN_RUN_ID) await lock.forceClear();
      else await lock.release(rec.runId);
      return rec;
    },

    startIssueRun,
    drainQueue,

    /**
     * A due scheduled job joins the run queue (or starts, if nothing is ahead of it).
     * @param {import('./scheduledJobs.js').ScheduledJob} job
     */
    submitJob: (job) => submit({ kind: 'job', job }, OWNER),

    /** Resolves once the current run (if any) has been reported and unlocked, and the queue drain it kicked off is done. */
    idle: async () => {
      await settled;
      await lastDrain;
    },
  };
}
