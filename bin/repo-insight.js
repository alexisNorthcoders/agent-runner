#!/usr/bin/env node
/**
 * The `repo_insight` Scheduled job: decide today's target workspace, explore it in a read-only
 * agent session and file one `agent-suggested` issue. The last stdout line is the outcome report.
 * `npm run repo-insight`.
 */
import { createClient } from 'redis';
import { loadConfig } from '../src/config.js';
import { createRedisStore } from '../src/redisStore.js';
import { createCronState } from '../src/cronState.js';
import { createWorkspaceAllowlist } from '../src/workspaces.js';
import { createIssuePipeline } from '../src/issuePipeline/index.js';
import { createReadOnlySessionLauncher } from '../src/agentBackend/claude.js';
import { createRepoInsightCursor, createRepoInsightLookups, decideRepoInsightTarget, runRepoInsight } from '../src/repoInsight.js';

const config = loadConfig();
const redis = createClient({ url: config.redisUrl, socket: { connectTimeout: 2000, reconnectStrategy: false } });
redis.on('error', () => {});
try {
  await redis.connect();
  const store = createRedisStore(redis);
  const workspaces = createWorkspaceAllowlist();
  const github = createIssuePipeline({ settings: config.pipeline }).github;
  const lookups = createRepoInsightLookups({ workspaces, github, prAttempts: createCronState({ store }).prAttempts });
  const target = await decideRepoInsightTarget({ cursor: createRepoInsightCursor({ store }), isIdle: lookups.isIdle, pastSuggestions: lookups.pastSuggestions });
  const line = await runRepoInsight({
    target,
    resolveWorkspace: (alias) => workspaces.resolveIssueWorkspace(alias),
    resolveRepo: (root, alias) => github.resolveIssueRepo(root, alias),
    launchSession: createReadOnlySessionLauncher(),
    createIssue: github.createIssue,
  });
  console.log(line);
} catch (err) {
  console.error(`repo-insight: ${err.message}`);
  process.exitCode = 1;
} finally {
  await redis.quit().catch(() => {});
}
