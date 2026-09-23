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
 *   workspaceRoot: string,
 *   logsDir: string,
 *   preamble: string,
 *   newRunId?: () => string,
 *   now?: () => number,
 *   isAlive?: (pid: number) => boolean,
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
  workspaceRoot,
  logsDir,
  preamble,
  newRunId = timestampRunId,
  now = Date.now,
  isAlive = pidAlive,
  logger = console,
}) {
  /**
   * The run this process is executing, if any.
   * @type {null | {
   *   record: import('./runLock.js').RunRecord,
   *   run: import('./agentBackend/index.js').AgentRun,
   *   progress: import('./agentBackend/index.js').AgentProgress | null,
   *   tracker: ReturnType<ReturnType<typeof import('./activeRuns.js').createActiveRuns>['track']>,
   * }}
   */
  let active = null;
  /** Settles when the active run has been reported and its lock released. */
  let settled = Promise.resolve();

  /** @param {typeof active} a */
  async function finishRun(a) {
    const { record } = a;
    const result = await a.run.done;
    try {
      await outbox.send({ replyTo: record.replyTo, runId: record.runId, text: formatRunResult(record, result) });
    } catch (err) {
      logger.error(`run ${record.runId}: outbox write failed:`, err?.message || err);
    }
    const endedAt = now();
    try {
      await history.append({
        runId: record.runId,
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
      });
    } catch (err) {
      logger.warn(`run ${record.runId}: history write failed:`, err?.message || err);
    }
    // after the history write, so the CLIs never lose sight of the run
    await a.tracker.finish();
    active = null;
    try {
      await lock.release(record.runId);
    } catch (err) {
      logger.error(`run ${record.runId}: lock release failed (expires on its own):`, err?.message || err);
    }
  }

  /**
   * @param {{ kind: 'freeform', prompt: string } | { kind: 'joplin', noteQuery: string }} cmd
   * @param {string} replyTo
   */
  async function startRun(cmd, replyTo) {
    const paused = await pause.get();
    if (paused) return `agent-runner is paused (${paused.reason}). Try again in a minute.`;

    const runId = newRunId();
    /** @type {import('./runLock.js').RunRecord} */
    const record = {
      runId,
      kind: cmd.kind,
      label: cmd.kind === 'freeform' ? oneLine(cmd.prompt, 60) : `joplin:${cmd.noteQuery}`,
      replyTo,
      startedAt: new Date(now()).toISOString(),
      workspaceRoot,
      logPath: join(logsDir, `${runId}.log`),
      ownerPid: process.pid,
      agentPid: null,
    };
    if (!(await lock.tryAcquire(record))) {
      const cur = await lock.current();
      const what = cur ? ` ${capitalize(describeRun(cur))} is in progress.` : '';
      return `Agent is busy.${what} Try again later.`;
    }
    // safe-restart may have paused between the check above and taking the lock; it re-checks the
    // lock after pausing, so checking the pause again here means one side always backs off
    const pausedNow = await pause.get();
    if (pausedNow) {
      await lock.release(runId);
      return `agent-runner is paused (${pausedNow.reason}). Try again in a minute.`;
    }

    try {
      let prompt;
      let source = '';
      if (cmd.kind === 'joplin') {
        let note;
        try {
          note = await joplin.getNote(cmd.noteQuery);
        } catch (err) {
          await lock.release(runId);
          return `Failed to read Joplin note: ${err?.message || err}`;
        }
        if (!note.body.trim()) {
          await lock.release(runId);
          return `Joplin note "${note.title}" (${note.id}) is empty. Nothing to run.`;
        }
        prompt = note.body.trim();
        record.label = `Joplin note "${note.title}"`;
        source = ` from Joplin note "${note.title}"`;
      } else {
        prompt = cmd.prompt;
      }

      const run = await backend.start({
        prompt,
        preamble,
        cwd: workspaceRoot,
        logPath: record.logPath,
        onProgress: (p) => {
          if (active?.record.runId !== runId) return;
          active.progress = p;
          active.tracker.update(p);
        },
      });
      const running = { ...record, agentPid: run.pid };
      const a = { record: running, run, progress: null, tracker: activeRuns.track(running) };
      active = a;
      settled = finishRun(a).catch((err) => logger.error(`run ${runId}: finish failed:`, err));
      await lock.update(a.record).catch(() => {});
      return `Started run ${runId}${source} in ${workspaceRoot}.\nLog: ${record.logPath}`;
    } catch (err) {
      if (!active || active.record.runId !== runId) await lock.release(runId).catch(() => {});
      return `Could not start the agent: ${err?.message || err}`;
    }
  }

  async function stop() {
    if (active) {
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
        case 'status':
          return { reply: renderStatusText(await statusSnapshot()) };
        case 'history':
          return { reply: renderHistoryText(await history.read({ limit: cmd.count }), now()) };
        default:
          return { reply: await startRun(cmd, replyTo) };
      }
    },

    /** @returns {Promise<{ busy: boolean, activeRun: (import('./runLock.js').RunRecord & Partial<import('./agentBackend/index.js').AgentProgress>) | null, paused: boolean }>} */
    async status() {
      const [held, paused] = await Promise.all([lock.current(), pause.get()]);
      const live = active && held?.runId === active.record.runId ? active.progress : null;
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
      const orphan =
        rec.agentPid && isAlive(rec.agentPid)
          ? `\nIts agent process (pid ${rec.agentPid}) is still running, but nobody will report its result.`
          : '';
      const log = rec.logPath ? `\nLog: ${rec.logPath}` : '';
      await outbox.send({
        replyTo: OWNER,
        runId: rec.runId === UNKNOWN_RUN_ID ? '' : rec.runId,
        text: `${name} was interrupted: agent-runner restarted before it finished.${orphan}${log}`,
      });
      if (rec.runId === UNKNOWN_RUN_ID) await lock.forceClear();
      else await lock.release(rec.runId);
      return rec;
    },

    /** Resolves once the current run (if any) has been reported and unlocked. */
    idle: () => settled,
  };
}
