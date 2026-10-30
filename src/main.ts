import { spawn } from 'child_process';
import { mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.ts';
import { connectRedis, createRedisStore, subscribeStateChanges } from './redisStore.ts';
import { createRunLock } from './runLock.ts';
import { createPauseFlag } from './pauseFlag.ts';
import { createRunQueue } from './runQueue.ts';
import { createManualPause } from './manualPause.ts';
import { createUsageLimitPause } from './usageLimitPause.ts';
import { createOutbox } from './outbox.ts';
import { createAgentBackend } from './agentBackend/index.ts';
import { createRunHistory } from './runHistory.ts';
import { createActiveRuns } from './activeRuns.ts';
import { createCronState } from './cronState.ts';
import { createCronTracer } from './cronTracer.ts';
import { collectStatus } from './statusCollect.ts';
import { createJoplinClient } from './joplin.ts';
import { buildFreeformPreamble, buildPreamble } from './preamble.ts';
import { createRunner } from './runner.ts';
import { createHttpServer } from './http.ts';
import { createWorkspaceAllowlist } from './workspaces.ts';
import { createIssuePipeline } from './issuePipeline/index.ts';
import { createStateChanges, notifyingStore } from './stateChanges.ts';
import { collectOfficeSnapshot } from './officeSnapshot.ts';
import { createOfficeFeed } from './officeFeed.ts';
import { createLogTail } from './logTail.ts';
import { createJobLauncher } from './jobProcess.ts';
import { createJobScheduler, jobSchedule, loadJobsFile } from './scheduledJobs.ts';
import { createIssueScan } from './issueScan.ts';
import { createSessionWatch } from './sessionWatch.ts';
import { errorText } from './narrow.ts';
import { createSpecCommands } from './specCommands.ts';

async function main() {
  const config = loadConfig();
  const QUEUE_POLL_MS = 15_000;

  /**
   * Run `bin/safe-restart.ts` fully detached. The `sh … &` double fork re-parents it away from this
   * process, so the `pm2 restart` it issues (which kills this process tree) doesn't kill it too.
   */
  function launchSafeRestart(replyTo: string) {
    const logFile = join(config.repoRoot, 'logs', 'safe-restart.log');
    mkdirSync(join(config.repoRoot, 'logs'), { recursive: true });
    spawn(
      'sh',
      ['-c', 'setsid "$0" bin/safe-restart.ts --reply-to "$1" >> "$2" 2>&1 < /dev/null &', process.execPath, replyTo, logFile],
      { cwd: config.repoRoot, detached: true, stdio: 'ignore' }
    ).unref();
  }

  const redis = await connectRedis({ url: config.redisUrl });
  // every Redis state write (lock, queue, pauses, cron state) tells the office feed
  const changes = createStateChanges();
  const store = notifyingStore(createRedisStore(redis), changes.notify);
  // …and so does every write another process announces (npm run agent:pause, safe-restart)
  const unsubscribeChanges = await subscribeStateChanges(redis, (key) => changes.notify(`elsewhere: ${key}`)).catch((err) => {
    console.warn(`agent-runner: cannot subscribe to state changes from other processes: ${errorText(err)}`);
    return async () => {};
  });
  const lock = createRunLock({ store, ttlSeconds: config.lockTtlSeconds });
  const outbox = createOutbox({ store });
  const pause = createPauseFlag({ store });
  const queue = createRunQueue({ store });
  const manualPause = createManualPause({ store });
  const usageLimit = createUsageLimitPause({ store });
  const history = createRunHistory({ dir: config.logsDir });
  const activeRuns = createActiveRuns({ dir: config.logsDir });
  const cronState = createCronState({ store });
  const workspaces = createWorkspaceAllowlist();
  const issues = createIssuePipeline({ settings: config.pipeline });

  // the interactive sessions open on the Pi, from their transcripts (started below, once the feed exists)
  const sessionWatch = createSessionWatch({
    root: config.sessionWatch.root,
    workspaces,
    intervalMs: config.sessionWatch.intervalMs,
    activeMs: config.sessionWatch.activeMs,
    onChange: changes.notify,
  });

  const statusSnapshot = () =>
    collectStatus({ readSessions: async () => sessionWatch.current(), activeRuns, history, readCron: cronState.read, readPause: pause.get, readLock: lock.current, readQueue: queue.list, readManualPauses: manualPause.list, readUsageLimit: usageLimit.get });

  const runner = createRunner({
    lock,
    pause,
    manualPause,
    usageLimit,
    queue,
    outbox,
    backend: createAgentBackend({ timeoutMs: config.agentTimeoutMs }),
    history,
    activeRuns,
    statusSnapshot,
    joplin: createJoplinClient(config.joplin),
    launchSafeRestart,
    workspaces,
    issues,
    specs: createSpecCommands({ workspaces, github: issues.github }),
    jobs: createJobLauncher(),
    workspaceRoot: config.workspaceRoot,
    logsDir: config.logsDir,
    preamble: buildPreamble({ repoRoot: config.repoRoot }),
    freeformPreamble: buildFreeformPreamble({ repoRoot: config.repoRoot }),
    onChange: changes.notify,
  });

  // Runs killed with the previous process (e.g. a restart mid-run) would otherwise show as `stale`
  // forever. Orphaned ones (agent still alive) are kept. This runs before the port is bound, so no
  // run of ours has started and every file's owner is a previous process (whose pid may be reused).
  // If another runner is up, its runs have live agents and are kept too.
  const removed = await activeRuns.removeStale({ ownersGone: true }).catch(() => []);
  if (removed.length) console.warn(`agent-runner: removed stale active-run files: ${removed.join(', ')}`);

  // the work waiting in each workspace's repo, for the office: scanned now, on a timer and after each run
  const issueScan = createIssueScan({
    workspaces,
    github: issues.github,
    prAttempts: cronState.prAttempts,
    intervalMs: config.issueScan.intervalMs,
    onChange: changes.notify,
  });
  changes.subscribe((reason) => {
    if (reason === 'run-ended') void issueScan.scan();
  });
  issueScan.start();
  if (config.sessionWatch.enabled) sessionWatch.start();
  else console.log('agent-runner: session watch disabled (SESSION_WATCH_DISABLE)');

  const officeFeed = createOfficeFeed({
    snapshot: () =>
      collectOfficeSnapshot({
        statusSnapshot,
        liveRun: runner.status,
        workspaceAliases: workspaces.aliases,
        issues: issueScan.current,
        sessions: sessionWatch.current,
        jobs: () => jobSchedule({ loadJobs: () => loadJobsFile(config.jobs.file), store }),
      }),
    subscribe: changes.subscribe,
    logTail: createLogTail({ current: runner.activeLog }),
  });
  const server = createHttpServer({ runner, officeFeed });
  // Bind before recovery: if another runner holds the port we exit here, so any lock found below
  // really was left by a dead process.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => resolve(undefined));
  }).catch((err) => {
    console.error(`agent-runner: cannot listen on 127.0.0.1:${config.port}:`, errorText(err));
    process.exit(1);
  });
  console.log(`agent-runner listening on http://127.0.0.1:${config.port} (workspace ${config.workspaceRoot})`);

  try {
    const interrupted = await runner.recoverInterruptedRun();
    if (interrupted) console.warn(`agent-runner: reported interrupted run ${interrupted.runId} to owner`);
    // recovery may have stopped an orphaned agent, which makes its active-run file stale
    if (interrupted) await activeRuns.removeStale({ ownersGone: true }).catch(() => []);
  } catch (err) {
    console.error('agent-runner: startup recovery failed:', errorText(err));
  }

  // Requests queued before a restart start now, and the timer picks the queue back up once a pause
  // (e.g. the one safe-restart holds while this process starts, or the usage-limit pause) ends.
  await runner.drainQueue();
  const queueTimer = setInterval(() => runner.drainQueue(), QUEUE_POLL_MS);
  queueTimer.unref();

  // After recovery and the first drain: a job missed while the runner was down fires now, behind
  // whatever was already queued.
  const scheduler = createJobScheduler({
    store,
    loadJobs: () => loadJobsFile(config.jobs.file),
    submitJob: runner.submitJob,
    outbox,
  });
  await scheduler.start();

  // After recovery, so a leftover lock can't make the first tick skip.
  const cron = createCronTracer({
    startIssueRun: runner.startIssueRun,
    lock,
    pause,
    manualPause,
    usageLimit,
    sweepStale: () => activeRuns.removeStale(),
    state: cronState,
    workspaces,
    github: issues.github,
    outbox,
    aliases: config.cron.aliases,
    intervalMs: config.cron.intervalMs,
  });
  if (config.cron.enabled) {
    if (!process.env.CLAUDE_ISSUE_DEFAULT_ALIAS?.trim()) console.warn('agent-runner: CLAUDE_ISSUE_DEFAULT_ALIAS is unset, so the cron polls only its secondary workspaces');
    await cron.start();
  } else {
    console.log('agent-runner: cron issue tracer disabled (CRON_ISSUE_TRACER_DISABLE)');
    await cronState.clear().catch(() => {});
  }

  // A run in flight is left alone: PM2 kills the agent with this process tree, and the lock left
  // in Redis makes the next start report the run as interrupted.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sig, () => {
      cron.stop();
      issueScan.stop();
      sessionWatch.stop();
      scheduler.stop();
      clearInterval(queueTimer);
      officeFeed.close();
      server.close();
      unsubscribeChanges()
        .then(() => redis.quit()).finally(() => process.exit(0));
    });
  }
}

// PM2 loads this file with import() from its own wrapper, so import.meta.main is false there. Its
// pm_exec_path names the script; agent runs inherit it, so the match has to be exact. PM2 keeps the
// path as given while ESM resolves symlinks, so compare real paths.
function startedByPm2() {
  if (!process.env.pm_exec_path) return false;
  try {
    return realpathSync(process.env.pm_exec_path) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (import.meta.main || startedByPm2()) await main();
