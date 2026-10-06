/**
 * Rotation for `repo_insight`: which workspace to visit next. Pure decision-making plus the
 * cursor's persistence; no GitHub calls or agent sessions.
 *
 * - `agent-runner:repo-insight:cursor` (string): the alias last visited.
 */

import { classifyReadyIssues } from './cronTracer.js';

/** @typedef {import('./issuePipeline/githubIssue.js').SuggestedIssue} SuggestedIssue */

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
  return rotationFrom(order, cursor).find(isIdle) ?? null;
}

/**
 * The order the picker visits workspaces in: just after the cursor, wrapping, the cursor last.
 * A cursor that isn't in the order (or is null) starts from the top.
 * @param {readonly string[]} order
 * @param {string | null} cursor
 * @returns {string[]}
 */
export function rotationFrom(order, cursor) {
  const start = cursor == null ? -1 : order.indexOf(cursor);
  return order.map((_, i) => order[(start + 1 + i) % order.length]);
}

/**
 * Today's target: check workspaces in rotation order, lazily, until one is idle. The cursor is
 * persisted the moment one is found, before its past suggestions are fetched, so a later failure
 * doesn't skip it next time. Nothing idle leaves the cursor alone. Takes no agent action and
 * writes nothing to GitHub.
 * @param {{
 *   order?: readonly string[],
 *   cursor: { read: () => Promise<string | null>, write: (alias: string) => Promise<unknown> },
 *   isIdle: (alias: string) => Promise<boolean>,
 *   pastSuggestions: (alias: string) => Promise<SuggestedIssue[]>,
 * }} deps
 * @returns {Promise<{ alias: string, pastSuggestions: SuggestedIssue[] } | null>} null when nothing is idle
 */
export async function decideRepoInsightTarget({ order = REPO_INSIGHT_PRIORITY, cursor, isIdle, pastSuggestions }) {
  for (const alias of rotationFrom(order, await cursor.read())) {
    if (!(await isIdle(alias))) continue;
    await cursor.write(alias);
    return { alias, pastSuggestions: await pastSuggestions(alias) };
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
