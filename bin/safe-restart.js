#!/usr/bin/env node
/**
 * `npm run safe-restart [-- --reply-to <replyTo>]`: the only sanctioned way to restart agent-runner.
 * Refuses while a run is active. With --reply-to (what `claude:restart` passes), the outcome also
 * goes to the outbox. Exit code 0 on restart, 1 on refusal or failure.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseArgs } from 'util';
import { loadConfig } from '../src/config.js';
import { connectRedis, createRedisStore } from '../src/redisStore.js';
import { createRunLock } from '../src/runLock.js';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createOutbox } from '../src/outbox.js';
import { runSafeRestart } from '../src/safeRestart.js';

const READY_TIMEOUT_MS = 60_000;
const PM2_TIMEOUT_MS = 60_000;

const { values } = parseArgs({ options: { 'reply-to': { type: 'string' } } });
const replyTo = values['reply-to'];
const config = loadConfig();
const statusUrl = `http://127.0.0.1:${config.port}/status`;

async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`agent-runner did not answer ${statusUrl} within ${READY_TIMEOUT_MS / 1000}s. Check \`pm2 logs ${config.pm2Name}\`.`);
}

const redis = await connectRedis({ url: config.redisUrl });
const store = createRedisStore(redis);
const pauseFlag = createPauseFlag({ store });

// The pause is set and cleared in this process. runSafeRestart clears it in a `finally`, but a
// signal (Ctrl-C on `npm run safe-restart`, SIGTERM) skips that, so remember the token and clear
// it here too rather than leaving the runner paused until the TTL.
/** @type {string | null} */
let heldToken = null;
const pause = {
  ...pauseFlag,
  /** @param {string} reason */
  async set(reason) {
    heldToken = await pauseFlag.set(reason);
    return heldToken;
  },
  /** @param {string} token */
  async clear(token) {
    const cleared = await pauseFlag.clear(token);
    heldToken = null;
    return cleared;
  },
};
for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.once(sig, async () => {
    console.log(`safe-restart: got ${sig}, aborting`);
    try {
      if (heldToken) await pauseFlag.clear(heldToken);
    } catch (err) {
      console.error(`safe-restart: could not clear the pause (expires on its own): ${err?.message || err}`);
    }
    process.exit(1);
  });
}

let ok = false;
try {
  console.log(`${new Date().toISOString()} safe-restart of ${config.pm2Name}`);
  const result = await runSafeRestart({
    lock: createRunLock({ store, ttlSeconds: config.lockTtlSeconds }),
    pause,
    restartProcess: async () => {
      await promisify(execFile)('pm2', ['restart', config.pm2Name], { timeout: PM2_TIMEOUT_MS });
    },
    waitForReady,
  });
  ok = result.ok;
  console.log(result.message);
  if (replyTo) await createOutbox({ store }).send({ replyTo, text: result.message });
} finally {
  await redis.quit();
}
process.exit(ok ? 0 : 1);
