#!/usr/bin/env node
/**
 * One-off bootstrap for `repo_insight`: sweep every idle workspace once (fixed priority order),
 * filing one `agent-suggested` issue in each, then leave the rotation cursor on the last workspace
 * so the daily Scheduled job continues from there. Run it by hand: `npm run repo-insight:bootstrap`.
 * It starts a read-only agent session per idle workspace, so it can take a while.
 */
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { createRedisStore } from '../src/redisStore.js';
import { createCronState } from '../src/cronState.js';
import { createWorkspaceAllowlist } from '../src/workspaces.js';
import { createIssuePipeline } from '../src/issuePipeline/index.js';
import { createReadOnlySessionLauncher } from '../src/agentBackend/claude.js';
import { createRepoInsightCursor, createRepoInsightLookups, runRepoInsight, sweepRepoInsight } from '../src/repoInsight.js';

const config = loadConfig();
const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
redis.on('error', () => {});
try {
  await redis.connect();
  const store = createRedisStore(redis);
  const workspaces = createWorkspaceAllowlist();
  const github = createIssuePipeline({ settings: config.pipeline }).github;
  const lookups = createRepoInsightLookups({ workspaces, github, prAttempts: createCronState({ store }).prAttempts });
  const launchSession = createReadOnlySessionLauncher();
  const { lines, failed } = await sweepRepoInsight({
    cursor: createRepoInsightCursor({ store }),
    isIdle: lookups.isIdle,
    pastSuggestions: lookups.pastSuggestions,
    explore: (target) =>
      runRepoInsight({
        target,
        resolveWorkspace: (alias) => workspaces.resolveIssueWorkspace(alias),
        resolveRepo: (root, alias) => github.resolveIssueRepo(root, alias),
        launchSession,
        createIssue: github.createIssue,
      }),
  });
  for (const line of lines) console.log(line);
  if (failed) process.exitCode = 1;
} catch (err) {
  console.error(`repo-insight: ${err.message}`);
  process.exitCode = 1;
} finally {
  await redis.quit().catch(() => {});
}
