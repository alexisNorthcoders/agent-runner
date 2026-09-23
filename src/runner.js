import { join } from 'path';
import { parseCommand } from './commands.js';
import { OWNER } from './outbox.js';
import { decideSafeRestart } from './safeRestart.js';
import { describeRun, UNKNOWN_RUN_ID } from './runLock.js';
import { pidAlive } from './pidAlive.js';
import { renderHistoryText, renderStatusText } from './statusFormat.js';

/**
 * The runner: turns a `claude…` command into at most one agent run at a time and reports every
 * outcome through the outbox. HTTP (src/http.js) and startup (src/main.js) are thin shells over it.
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
 * @typedef {import('./agentBackend/index.js').AgentRun} AgentRun
 * @typedef {{
 *   record: import('./runLock.js').RunRecord,
 *   run: AgentRun,
 *   progress: import('./agentBackend/index.js').AgentProgress | null,
 *   phase: 'agent' | 'post-run',
 *   stopRequested: boolean,
 *   tracker: ReturnType<ReturnType<typeof import('./activeRuns.js').createActiveRuns>['track']>,
 *   followUps?: Array<{ label: string, outcome: string, logPath: string, costUsd: number | null, turns: number }>,
 * }} ActiveRun
 */

/**
 * @param {{
 *   lock: ReturnType<typeof import('./runLock.js').createRunLock>,
 *   pause: ReturnType<typeof import('./pauseFlag.js').createPauseFlag>,
 *   outbox: ReturnType<typeof import('./outbox.js').createOutbox>,
 *   backend: import('./agentBackend/index.js').AgentBackend,
 *   history: Pick<ReturnType<typeof import('./runHistory.js').createRunHistory>, 'append' | 'read'>,
 *   activeRuns: Pick<ReturnType<typeof import('./activeRuns.js').createActiveRuns>, 'track'>,
 *   statusSnapshot: () => Promise<import('./statusCollect.js').StatusSnapshot>,
 *   joplin: { getNote: (query: string) => Promise<{ id: string, title: string, body: string }> },
 *   launchSafeRestart: (replyTo: string) => void,
 *   workspaces?: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }> },
 *   issues?: Pick<import('./issuePipeline/index.js').IssuePipeline, 'prepare' | 'finish' | 'commitInterruptedWork'>,
 *   workspaceRoot: string,
 *   logsDir: string,
 *   preamble: string,
 *   newRunId?: () => string,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
 *   stopOrphanAgent?: (pid: number) => Promise<boolean>,
 *   logger?: Pick<Console, 'error' | 'warn' | 'info'>,
 * }} deps
 */
export function createRunner({
  lock,
  pause,
  outbox,
  backend,
  history,
  activeRuns,
  statusSnapshot,
  joplin,
  launchSafeRestart,
  workspaces,
  issues,
  workspaceRoot,
  logsDir,
  preamble,
  newRunId = timestampRunId,
  now = Date.now,
  isAlive = pidAlive,
  stopOrphanAgent = async (pid) => (backend.stopOrphan ? backend.stopOrphan(pid) : false),
  logger = console,
}) {
  /** The run this process is executing, if any. @type {ActiveRun | null} */
  let active = null;
  /** Settles when the active run has been reported and its lock released. */
  let settled = Promise.resolve();

  /** @param {string} runId */
  const trackProgress = (runId) => (p) => {
    if (active?.record.runId !== runId) return;
    active.progress = p;
    active.tracker.update(p);
  };

  /**
   * Take the single-flight lock for `record`. Returns an error reply, or null once it's held.
   * @param {import('./runLock.js').RunRecord} record
   */
  async function acquire(record) {
    const paused = await pause.get();
    if (paused) return `agent-runner is paused (${paused.reason}). Try again in a minute.`;
    if (!(await lock.tryAcquire(record))) {
      const cur = await lock.current();
      const what = cur ? ` ${capitalize(describeRun(cur))} is in progress.` : '';
      return `Agent is busy.${what} Try again later.`;
    }
    // safe-restart may have paused between the check above and taking the lock; it re-checks the
    // lock after pausing, so checking the pause again here means one side always backs off
    const pausedNow = await pause.get();
    if (pausedNow) {
      await lock.release(record.runId);
      return `agent-runner is paused (${pausedNow.reason}). Try again in a minute.`;
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
   * Start the agent for a run that holds the lock, then report in the background: `report` turns
   * the agent's result into the outbox text (or null to send nothing) and extra history fields.
   * Releases the lock if the agent can't start.
   * @param {import('./runLock.js').RunRecord} record
   * @param {Omit<import('./agentBackend/index.js').AgentStartOptions, 'preamble' | 'logPath' | 'onProgress'>} opts
   * @param {(result: import('./agentBackend/index.js').AgentResult, a: ActiveRun) => Promise<{ text: string | null, history?: object }>} report
   */
  async function launch(record, opts, report) {
    const { runId } = record;
    let run;
    try {
      run = await backend.start({ ...opts, preamble, logPath: record.logPath, onProgress: trackProgress(runId) });
    } catch (err) {
      await lock.release(runId).catch(() => {});
      throw err;
    }
    const running = { ...record, agentPid: run.pid };
    /** @type {ActiveRun} */
    const a = { record: running, run, progress: null, phase: 'agent', stopRequested: false, tracker: activeRuns.track(running) };
    active = a;
    await lock.update(a.record).catch(() => {});
    const done = (async () => {
      const result = await run.done;
      a.phase = 'post-run';
      let out = { text: formatRunResult(record, result), history: {} };
      try {
        out = { history: {}, ...(await report(result, a)) };
      } catch (err) {
        logger.error(`run ${runId}: report failed:`, err);
      }
      if (out.text) {
        try {
          await outbox.send({ replyTo: record.replyTo, runId, text: out.text });
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
          logPath: result.logPath,
          startedAt: record.startedAt,
          endedAt: new Date(endedAt).toISOString(),
          durationMs: endedAt - Date.parse(record.startedAt),
          backend: backend.name,
          outcome: result.outcome,
          exitCode: result.exitCode,
          ...result.usage,
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
        try {
          await lock.release(runId);
        } catch (err) {
          logger.error(`run ${runId}: lock release failed (expires on its own):`, err?.message || err);
        }
      });
    return a;
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
        a.phase = 'agent';
        a.record = { ...a.record, agentPid: run.pid };
        // re-publish with the new agent pid (the tracker's record is fixed)
        await a.tracker.finish();
        a.tracker = activeRuns.track(a.record);
        await lock.update(a.record).catch(() => {});
        const result = await run.done;
        a.phase = 'post-run';
        a.followUps.push({ label, outcome: result.outcome, logPath, costUsd: result.usage.costUsd, turns: result.usage.turns });
        return result;
      } catch (err) {
        a.phase = 'post-run';
        return { outcome: 'spawn_error', exitCode: null, text: '', stderr: err?.message || String(err) };
      }
    };

  /**
   * @param {{ kind: 'freeform', prompt: string } | { kind: 'joplin', noteQuery: string }} cmd
   * @param {string} replyTo
   */
  async function startRun(cmd, replyTo) {
    const record = newRecord({
      kind: cmd.kind,
      label: cmd.kind === 'freeform' ? oneLine(cmd.prompt, 60) : `joplin:${cmd.noteQuery}`,
      replyTo,
      workspaceRoot,
    });
    const refused = await acquire(record);
    if (refused) return refused;

    try {
      let prompt;
      let source = '';
      if (cmd.kind === 'joplin') {
        let note;
        try {
          note = await joplin.getNote(cmd.noteQuery);
        } catch (err) {
          await lock.release(record.runId);
          return `Failed to read Joplin note: ${err?.message || err}`;
        }
        if (!note.body.trim()) {
          await lock.release(record.runId);
          return `Joplin note "${note.title}" (${note.id}) is empty. Nothing to run.`;
        }
        prompt = note.body.trim();
        record.label = `Joplin note "${note.title}"`;
        source = ` from Joplin note "${note.title}"`;
      } else {
        prompt = cmd.prompt;
      }
      await launch(record, { prompt, cwd: workspaceRoot }, async (result) => ({ text: formatRunResult(record, result) }));
      return `Started run ${record.runId}${source} in ${workspaceRoot}.\nLog: ${record.logPath}`;
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      return `Could not start the agent: ${err?.message || err}`;
    }
  }

  /**
   * The one entry point for issue runs, manual (`claude issue:…`) and cron: resolve the allowlisted
   * workspace, take the lock, fetch the issue and branch in place, run the agent with the
   * implement workflow, then post-run, then one outbox message.
   * @param {{ issueNumber: number, alias: string | null, extraInstructions?: string, replyTo: string, trigger?: 'manual' | 'cron' }} p
   * @returns {Promise<{ reply: string, done: Promise<import('./issuePipeline/index.js').IssueRunResult | null> | null, refused?: boolean }>}
   *   `done` (null when nothing started) settles once the run has been reported and unlocked.
   *   `refused` means the lock was held or the runner paused, so nothing was tried.
   */
  async function startIssueRun({ issueNumber, alias, extraInstructions = '', replyTo, trigger = 'manual' }) {
    if (!workspaces || !issues) return { reply: 'claude issue:<n> is not configured on this runner.', done: null };
    let ws;
    try {
      ws = await workspaces.resolveIssueWorkspace(alias);
    } catch (err) {
      return { reply: `Agent workspace: ${err?.message || err}`, done: null };
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
    if (refused) return { reply: refused, done: null, refused: true };

    let prep;
    try {
      prep = await issues.prepare({ issueNumber, alias: ws.alias, workspaceRoot: ws.root, extraInstructions });
    } catch (err) {
      await lock.release(record.runId).catch(() => {});
      return { reply: err?.message || String(err), done: null };
    }
    record.label = `issue ${ws.alias}#${issueNumber}${prep.issue.title ? ` "${oneLine(prep.issue.title, 50)}"` : ''}`;

    /** @type {import('./issuePipeline/index.js').IssueRunResult | null} */
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
        });
        outcome = fin.result;
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

  async function stop() {
    if (active) {
      active.stopRequested = true;
      if (active.phase === 'post-run') {
        return `Run ${active.record.runId} is past the agent, in post-run (commit, PR, review, merge), which can't be interrupted. No further agent pass will start. Its report will follow.`;
      }
      active.run.stop();
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
        case 'issue':
          return { reply: (await startIssueRun({ ...cmd, replyTo })).reply };
        case 'status':
          return { reply: renderStatusText(await statusSnapshot()) };
        case 'history':
          return { reply: renderHistoryText(await history.read({ limit: cmd.count }), now()) };
        default:
          return { reply: await startRun(cmd, replyTo) };
      }
    },

    /** @returns {Promise<{ busy: boolean, activeRun: (import('./runLock.js').RunRecord & Partial<import('./agentBackend/index.js').AgentProgress> & { phase?: ActiveRun['phase'] }) | null, paused: boolean }>} */
    async status() {
      const [held, paused] = await Promise.all([lock.current(), pause.get()]);
      const live = active && held?.runId === active.record.runId ? { ...active.progress, phase: active.phase } : null;
      return {
        busy: Boolean(held),
        activeRun: held ? { ...held, ...(live ?? {}) } : null,
        paused: Boolean(paused),
      };
    },

    /**
     * On startup, any lock is left over from a previous process (the HTTP port is bound first, so
     * no other runner is alive): tell `owner`, then free the lock. The pause flag is not ours to clear.
     */
    async recoverInterruptedRun() {
      const rec = await lock.current();
      if (!rec) return null;
      const name = `Agent ${describeRun(rec)}`;
      let agentAlive = Boolean(rec.agentPid && isAlive(rec.agentPid));
      let orphan = '';
      if (agentAlive) {
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

    /** Resolves once the current run (if any) has been reported and unlocked. */
    idle: () => settled,
  };
}
