import dotenv from 'dotenv';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { loadPipelineSettings } from './issuePipeline/settings.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: join(REPO_ROOT, '.env') });

const int = (v, fallback) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Runtime config from the environment (`.env`, see `.env.example`). */
export function loadConfig(env = process.env) {
  const agentTimeoutMs = int(env.AGENT_TIMEOUT_MS, 20 * 60 * 1000);
  const pipeline = loadPipelineSettings(env);
  return {
    repoRoot: REPO_ROOT,
    port: int(env.AGENT_RUNNER_PORT, 3790),
    pm2Name: env.AGENT_RUNNER_PM2_NAME?.trim() || 'agent-runner',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6379',
    workspaceRoot: env.AGENT_WORKSPACE?.trim() || join(homedir(), 'Projects'),
    logsDir: join(REPO_ROOT, 'logs', 'agent-runs'),
    agentTimeoutMs,
    // outlives the longest possible run (an issue run: agent, autofix agent, merge waits, issue-close
    // poll); only matters if the runner dies without releasing
    lockTtlSeconds: Math.ceil((2 * agentTimeoutMs + 2 * pipeline.mergeableWait.maxWaitMs + pipeline.issueCloseWait.maxWaitMs) / 1000) + 20 * 60,
    pipeline,
    joplin: {
      baseUrl: env.JOPLIN_API_URL?.trim() || 'http://127.0.0.1:41184',
      token: env.JOPLIN_API_TOKEN?.trim() || '',
      notebook: env.JOPLIN_AGENT_NOTEBOOK?.trim() || 'WhatsApp Bot',
    },
  };
}
