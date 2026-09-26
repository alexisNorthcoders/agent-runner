import { spawn } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { loadConfig } from './config.js';
import { connectRedis, createRedisStore, subscribeStateChanges } from './redisStore.js';
import { createRunLock } from './runLock.js';
import { createPauseFlag } from './pauseFlag.js';
import { createRunQueue } from './runQueue.js';
import { createManualPause } from './manualPause.js';
import { createOutbox } from './outbox.js';
import { createAgentBackend } from './agentBackend/index.js';
import { createRunHistory } from './runHistory.js';
import { createActiveRuns } from './activeRuns.js';
import { createCronState } from './cronState.js';
import { createCronTracer } from './cronTracer.js';
import { collectStatus } from './statusCollect.js';
import { createJoplinClient } from './joplin.js';
import { buildFreeformPreamble, buildPreamble } from './preamble.js';
import { createRunner } from './runner.js';
import { createHttpServer } from './http.js';
import { createWorkspaceAllowlist } from './workspaces.js';
import { createIssuePipeline } from './issuePipeline/index.js';
import { createStateChanges, notifyingStore } from './stateChanges.js';
import { collectOfficeSnapshot } from './officeSnapshot.js';
import { createOfficeFeed } from './officeFeed.js';
import { createLogTail } from './logTail.js';
import { createJobLauncher } from './jobProcess.js';
import { createJobScheduler, loadJobsFile } from './scheduledJobs.js';

const config = loadConfig();
const QUEUE_POLL_MS = 15_000;

/**
 * Run `bin/safe-restart.js` fully detached. The `sh … &` double fork re-parents it away from this
 * process, so the `pm2 restart` it issues (which kills this process tree) doesn't kill it too.
 * @param {string} replyTo
 */
function launchSafeRestart(replyTo) {
  const logFile = join(config.repoRoot, 'logs', 'safe-restart.log');
  mkdirSync(join(config.repoRoot, 'logs'), { recursive: true });
  spawn(
    'sh',
    ['-c', 'setsid "$0" bin/safe-restart.js --reply-to "$1" >> "$2" 2>&1 < /dev/null &', process.execPath, replyTo, logFile],
    { cwd: config.repoRoot, detached: true, stdio: 'ignore' }
  ).unref();
}

const redis = await connectRedis({ url: config.redisUrl });
// every Redis state write (lock, queue, pauses, cron state) tells the office feed
const changes = createStateChanges();
const store = notifyingStore(createRedisStore(redis), changes.notify);
// …and so does every write another process announces (npm run agent:pause, safe-restart)
const unsubscribeChanges = await subscribeStateChanges(redis, (key) => changes.notify(`elsewhere: ${key}`)).catch((err) => {
  console.warn(`agent-runner: cannot subscribe to state changes from other processes: ${err?.message || err}`);
  return async () => {};
});
const lock = createRunLock({ store, ttlSeconds: config.lockTtlSeconds });
const outbox = createOutbox({ store });
const pause = createPauseFlag({ store });
const queue = createRunQueue({ store });
const manualPause = createManualPause({ store });
const history = createRunHistory({ dir: config.logsDir });
const activeRuns = createActiveRuns({ dir: config.logsDir });
const cronState = createCronState({ store });
const workspaces = createWorkspaceAllowlist();
const issues = createIssuePipeline({ settings: config.pipeline });

const statusSnapshot = () =>
  collectStatus({ activeRuns, history, readCron: cronState.read, readPause: pause.get, readLock: lock.current, readQueue: queue.list, readManualPauses: manualPause.list });

const runner = createRunner({
  lock,
  pause,
  manualPause,
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

const officeFeed = createOfficeFeed({
  snapshot: () => collectOfficeSnapshot({ statusSnapshot, liveRun: runner.status, workspaceAliases: workspaces.aliases }),
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
  console.error(`agent-runner: cannot listen on 127.0.0.1:${config.port}:`, err.message);
  process.exit(1);
});
console.log(`agent-runner listening on http://127.0.0.1:${config.port} (workspace ${config.workspaceRoot})`);

try {
  const interrupted = await runner.recoverInterruptedRun();
  if (interrupted) console.warn(`agent-runner: reported interrupted run ${interrupted.runId} to owner`);
  // recovery may have stopped an orphaned agent, which makes its active-run file stale
  if (interrupted) await activeRuns.removeStale({ ownersGone: true }).catch(() => []);
} catch (err) {
  console.error('agent-runner: startup recovery failed:', err?.message || err);
}

// Requests queued before a restart start now, and the timer picks the queue back up once a pause
// (e.g. the one safe-restart holds while this process starts) is cleared.
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
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.once(sig, () => {
    cron.stop();
    scheduler.stop();
    clearInterval(queueTimer);
    officeFeed.close();
    server.close();
    unsubscribeChanges()
      .then(() => redis.quit()).finally(() => process.exit(0));
  });
}
