#!/usr/bin/env node
/**
 * Dry run of repo_insight's "today's target" decision: which workspace the rotation would pick
 * and its past agent-suggested issues. Reads GitHub only. Files no issue and starts no agent.
 * It does move the rotation cursor (as the real run would) unless `--no-persist` is given.
 * Also available as `npm run repo-insight:decide [-- --no-persist]`.
 */
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { createRedisStore } from '../src/redisStore.js';
import { createCronState } from '../src/cronState.js';
import { createWorkspaceAllowlist } from '../src/workspaces.js';
import { createIssuePipeline } from '../src/issuePipeline/index.js';
import { REPO_INSIGHT_PRIORITY, createRepoInsightCursor, createRepoInsightLookups, decideRepoInsightTarget } from '../src/repoInsight.js';

const persist = !process.argv.includes('--no-persist');
const config = loadConfig();
const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
redis.on('error', () => {});
try {
  await redis.connect();
  const store = createRedisStore(redis);
  const cursor = createRepoInsightCursor({ store });
  const lookups = createRepoInsightLookups({
    workspaces: createWorkspaceAllowlist(),
    github: createIssuePipeline({ settings: config.pipeline }).github,
    prAttempts: createCronState({ store }).prAttempts,
  });
  const before = await cursor.read();
  const target = await decideRepoInsightTarget({
    order: REPO_INSIGHT_PRIORITY,
    cursor: { read: async () => before, write: persist ? cursor.write : async () => {} },
    isIdle: async (alias) => {
      const idle = await lookups.isIdle(alias).catch((err) => {
        console.log(`  ${alias}: could not check (${err.message})`);
        throw err;
      });
      console.log(`  ${alias}: ${idle ? 'idle' : 'has runnable issues'}`);
      return idle;
    },
    pastSuggestions: lookups.pastSuggestions,
  });
  console.log(`cursor was: ${before ?? '(none)'}`);
  if (!target) console.log('nothing idle today (cursor unchanged)');
  else {
    console.log(`target: ${target.alias}${persist ? ' (cursor moved here)' : ' (cursor not persisted)'}`);
    console.log(`past agent-suggested issues: ${target.pastSuggestions.length}`);
    for (const s of target.pastSuggestions) console.log(`  #${s.number} [${s.state}] ${s.title}`);
  }
} catch (err) {
  console.error(`repo-insight: ${err.message}`);
  process.exitCode = 1;
} finally {
  await redis.quit().catch(() => {});
}
