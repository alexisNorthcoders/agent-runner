/**
 * Rotation for `repo_insight`: which workspace to visit next. Pure decision-making plus the
 * cursor's persistence; no GitHub calls or agent sessions.
 *
 * - `agent-runner:repo-insight:cursor` (string): the alias last visited.
 */

import { classifyReadyIssues } from './cronTracer.js';

export const REPO_INSIGHT_CURSOR_KEY = 'agent-runner:repo-insight:cursor';

export const REPO_INSIGHT_PRIORITY = [
  'bot',
  'chess-trainer',
  'agent-runner',
  'reddit-bot',
  'snake-phaser',
  'snake-colyseus',
  'go-server',
  'platformer',
  'snake-lab',
  'reply-buddy',
  'home-manuals',
  'dots',
];

/**
 * The next idle workspace: walk forward from just after the cursor, wrapping around the end. A
 * cursor that isn't in the order (or is null) starts from the top. The cursor itself is the last
 * candidate, so a lone idle workspace is picked again.
 * @param {readonly string[]} order
 * @param {Readonly<Record<string, boolean>> | ReadonlyMap<string, boolean>} idle alias → idle
 * @param {string | null} cursor the alias last visited
 * @returns {string | null} null when no workspace is idle
 */
export function pickNextIdleWorkspace(order, idle, cursor) {
  const isIdle = (/** @type {string} */ alias) => (idle instanceof Map ? idle.get(alias) : /** @type {any} */ (idle)[alias]) === true;
  const start = cursor == null ? -1 : order.indexOf(cursor);
  for (let i = 1; i <= order.length; i++) {
    const alias = order[(start + i) % order.length];
    if (isIdle(alias)) return alias;
  }
  return null;
}

/** @param {{ store: import('./redisStore.js').Store }} p */
export function createRepoInsightCursor({ store }) {
  return {
    /** @returns {Promise<string | null>} the alias last visited */
    async read() {
      const v = await store.get(REPO_INSIGHT_CURSOR_KEY);
      return v ? v : null;
    },

    /** @param {string} alias */
    async write(alias) {
      if (typeof alias !== 'string' || !alias) throw new TypeError(`repo insight: invalid alias ${JSON.stringify(alias)}`);
      await store.set(REPO_INSIGHT_CURSOR_KEY, alias);
    },
  };
}

/**
 * Read-only GitHub lookups for `repo_insight`, behind an injectable `github` (the same shape the
 * issue scan takes, plus `listAgentSuggestedIssues`).
 * @param {{
 *   workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }> },
 *   github: Pick<ReturnType<typeof import('./issuePipeline/githubIssue.js').createGithubIssues>,
 *     'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha' | 'listAgentSuggestedIssues'>,
 *   prAttempts: () => Promise<Map<string, string>>,
 * }} deps `prAttempts`: the cron's recorded PR attempts (`cronState.prAttempts`), read only.
 */
export function createRepoInsightLookups({ workspaces, github, prAttempts }) {
  /** @param {string} alias */
  const repoOf = async (alias) => github.resolveIssueRepo((await workspaces.resolveIssueWorkspace(alias)).root, alias);

  return {
    /**
     * Idle: no issue in the cron tracer's `runnable` bucket (ready-for-agent, not blocked, not
     * parked behind an attempted open PR). Throws when GitHub can't be read.
     * @param {string} alias
     */
    async isIdle(alias) {
      const repo = await repoOf(alias);
      const rows = await github.listOpenIssues(repo);
      const { runnable } = await classifyReadyIssues(github, repo, rows, await prAttempts());
      return runnable.length === 0;
    },

    /**
     * The repo's `agent-suggested` issues, open and closed, so a new suggestion doesn't repeat one.
     * @param {string} alias
     */
    async pastSuggestions(alias) {
      return github.listAgentSuggestedIssues(await repoOf(alias));
    },
  };
}
