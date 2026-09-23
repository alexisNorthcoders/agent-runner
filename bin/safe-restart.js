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
let ok = false;
try {
  console.log(`${new Date().toISOString()} safe-restart of ${config.pm2Name}`);
  const result = await runSafeRestart({
    lock: createRunLock({ store, ttlSeconds: config.lockTtlSeconds }),
    pause: createPauseFlag({ store }),
    restartProcess: async () => {
      await promisify(execFile)('pm2', ['restart', config.pm2Name]);
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
