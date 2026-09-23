#!/usr/bin/env node
/**
 * Terminal observability for agent-runner (think `pm2 status`). Reads the files under
 * `logs/agent-runs/` directly, plus the pause flag, lock and cron state from Redis, so it works
 * while the runner is down.
 * Also available as `npm run agent:status | agent:watch | agent:history | agent:logs`.
 */
import { spawn } from 'child_process';
import { access, readFile } from 'fs/promises';
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { createRedisStore } from '../src/redisStore.js';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createRunLock } from '../src/runLock.js';
import { createActiveRuns } from '../src/activeRuns.js';
import { createRunHistory } from '../src/runHistory.js';
import { createCronState } from '../src/cronState.js';
import { collectStatus } from '../src/statusCollect.js';
import { ansi, plain, renderHistoryLines, renderStatus } from '../src/statusFormat.js';

const USAGE = `agent-cli: observability for agent-runner

Usage:
  node bin/agent-cli.js [status] [--json]          snapshot: cron, active runs, pause, spend, recent runs
  node bin/agent-cli.js watch [seconds]            live view, refreshed every N seconds (default 2)
  node bin/agent-cli.js history [-n 20] [--json]   finished runs with model, tokens and cost
  node bin/agent-cli.js logs [runId|latest] [-f]   print (or follow) a run's log

Also available as: npm run agent:status | agent:watch | agent:history | agent:logs`;

const config = loadConfig();
const c = process.stdout.isTTY && !process.env.NO_COLOR ? ansi() : plain;
const activeRuns = createActiveRuns({ dir: config.logsDir });
const history = createRunHistory({ dir: config.logsDir });

/**
 * Redis over a client that fails fast instead of retrying forever (unlike the service's
 * `connectRedis`), and reconnects on the next call after a failure (for `watch`). A down Redis
 * shows as "unknown" in the status.
 */
function createRedisReader() {
  /** @type {Promise<ReturnType<typeof createClient>> | null} */
  let connecting = null;
  const connect = () =>
    (connecting ??= (async () => {
      const client = createClient({ url: config.redisUrl, socket: { connectTimeout: 1000, reconnectStrategy: false } });
      client.on('error', () => {});
      try {
        await client.connect();
        return client;
      } catch (err) {
        connecting = null;
        client.disconnect().catch(() => {});
        throw err;
      }
    })());
  /** @template T @param {(store: import('../src/redisStore.js').Store) => Promise<T>} fn */
  async function withStore(fn) {
    const client = await connect();
    try {
      return await fn(createRedisStore(client));
    } catch (err) {
      connecting = null;
      client.disconnect().catch(() => {});
      throw err;
    }
  }
  return {
    readPause: () => withStore((store) => createPauseFlag({ store }).get()),
    readLock: () => withStore((store) => createRunLock({ store, ttlSeconds: config.lockTtlSeconds }).current()),
    readCron: () => withStore((store) => createCronState({ store }).read()),
    async close() {
      const client = await connecting?.catch(() => null);
      await client?.quit().catch(() => {});
    },
  };
}

const redis = createRedisReader();
const collect = () =>
  collectStatus({
    activeRuns,
    history,
    readCron: redis.readCron,
    readPause: redis.readPause,
    readLock: redis.readLock,
  });

/** @param {string[]} args */
async function status(args) {
  const data = await collect();
  console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : renderStatus(data, c));
}

/** @param {number} seconds */
async function watch(seconds) {
  const intervalMs = Math.max(1, seconds) * 1000;
  for (;;) {
    const frame = renderStatus(await collect(), c);
    process.stdout.write(`\x1b[2J\x1b[H${frame}\n\n${c.dim(`refreshing every ${intervalMs / 1000}s, ctrl+c to exit`)}\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** @param {string[]} args */
async function showHistory(args) {
  const nIdx = args.indexOf('-n');
  const limit = nIdx !== -1 ? parseInt(args[nIdx + 1], 10) || 20 : 20;
  const rows = await history.read({ limit });
  if (args.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return console.log('No finished runs recorded yet.');
  console.log(renderHistoryLines(rows, Date.now(), c).join('\n'));
}

/** @param {string[]} args */
async function logs(args) {
  const follow = args.includes('-f');
  const target = args.find((a) => !a.startsWith('-')) ?? 'latest';
  const runs = [...(await activeRuns.list()).reverse(), ...(await history.read())];
  const run = target === 'latest' ? runs[0] : runs.find((r) => r.runId === target || r.runId.startsWith(target));
  if (!run?.logPath) throw new Error(target === 'latest' ? 'No runs recorded yet.' : `No run matching "${target}".`);
  await access(run.logPath);
  console.error(c.dim(run.logPath));
  if (!follow) return process.stdout.write(await readFile(run.logPath, 'utf8'));
  const tail = spawn('tail', ['-n', '+1', '-f', run.logPath], { stdio: 'inherit' });
  await new Promise((resolve) => tail.on('close', resolve));
}

const [cmd = 'status', ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'status':
      await status(rest);
      break;
    case 'watch':
      await watch(parseFloat(rest[0]) || 2);
      break;
    case 'history':
      await showHistory(rest);
      break;
    case 'logs':
      await logs(rest);
      break;
    case 'help':
    case '-h':
    case '--help':
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command "${cmd}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err?.message || String(err));
  process.exitCode = 1;
} finally {
  await redis.close();
}
