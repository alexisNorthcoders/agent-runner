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

  /**
   * The issues in the cron tracer's `runnable` bucket (ready-for-agent, not blocked, not parked
   * behind an attempted open PR), ascending. Throws when GitHub can't be read.
   * @param {string} alias
   * @returns {Promise<number[]>}
   */
  async function runnableIssues(alias) {
    const repo = await repoOf(alias);
    const rows = await github.listOpenIssues(repo);
    const { runnable } = await classifyReadyIssues(github, repo, rows, await prAttempts());
    return runnable.map((r) => r.number);
  }

  return {
    runnableIssues,

    /**
     * Idle: no runnable issue (see `runnableIssues`), whoever is or isn't working on them.
     * @param {string} alias
     */
    async isIdle(alias) {
      return (await runnableIssues(alias)).length === 0;
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

/**
 * The prompt of the read-only exploration session: the past suggestions go in so it doesn't
 * repeat one, open or closed.
 * @param {{ alias: string, pastSuggestions: SuggestedIssue[] }} p
 */
export function buildInsightPrompt({ alias, pastSuggestions }) {
  const past = pastSuggestions.length
    ? pastSuggestions.map((s) => `- #${s.number} [${s.state}] ${s.title}`).join('\n')
    : '_(none yet)_';
  return [
    `You are exploring the "${alias}" repository (your working directory) to suggest ONE improvement.`,
    'You are read-only: you can read and search files, nothing else. Do not try to edit, run commands or file anything.',
    '',
    'Look around (structure, README, key modules, tests, rough edges), then form a single concrete, well-scoped improvement idea.',
    'It must not repeat any idea already raised here, whether that issue is still open or was closed:',
    '',
    past,
    '',
    'Reply with ONLY a JSON object, no other text: {"title": "<short issue title>", "body": "<markdown issue body: the problem, the proposed change, acceptance criteria>"}',
  ].join('\n');
}

/**
 * Pull `{ title, body }` out of the session's final text (which may wrap the JSON in prose or a fence).
 * @param {string} text
 * @returns {{ title: string, body: string }}
 */
export function parseInsightIdea(text) {
  const s = String(text ?? '');
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.indexOf('{'); start >= 0 && start < end; start = s.indexOf('{', start + 1)) {
      try {
        const o = JSON.parse(s.slice(start, end + 1));
        const title = typeof o?.title === 'string' ? o.title.trim().replace(/\s+/g, ' ') : '';
        const body = typeof o?.body === 'string' ? o.body.trim() : '';
        if (title && body) return { title, body };
      } catch {
        /* not this span */
      }
    }
  }
  throw new Error('the exploration session returned no usable {title, body} idea');
}

export const REPO_INSIGHT_LABELS = ['agent-suggested', 'needs-triage'];

/**
 * Today's suggestion: given the decided target (null when nothing was idle), explore it read-only
 * and file one issue. Returns the final report line, which the Scheduled job prints.
 * @param {{
 *   target: { alias: string, pastSuggestions: SuggestedIssue[] } | null,
 *   resolveWorkspace: (alias: string) => Promise<{ root: string }>,
 *   resolveRepo: (root: string, alias: string) => Promise<string>,
 *   launchSession: (p: { cwd: string, prompt: string }) => Promise<{ text: string }>,
 *   createIssue: (repo: string, p: { title: string, body: string, labels: string[] }) => Promise<{ number: number, url: string, title: string }>,
 * }} deps
 * @returns {Promise<string>}
 */
export async function runRepoInsight({ target, resolveWorkspace, resolveRepo, launchSession, createIssue }) {
  if (!target) return 'repo-insight: nothing idle today, no suggestion filed';
  const { root } = await resolveWorkspace(target.alias);
  const repo = await resolveRepo(root, target.alias);
  const { text } = await launchSession({ cwd: root, prompt: buildInsightPrompt(target) });
  const idea = parseInsightIdea(text);
  const issue = await createIssue(repo, { ...idea, labels: REPO_INSIGHT_LABELS });
  return `repo-insight: ${target.alias} → filed #${issue.number} "${issue.title}" (${issue.url})`;
}

/**
 * The one-off bootstrap: visit every workspace in the fixed priority order (not from the cursor),
 * and run `explore` on each idle one. The cursor follows the sweep (written after each visit,
 * idle or not), so it ends on the last workspace of the list for the next daily run. A workspace
 * that fails (idleness check or exploration) is reported and the sweep carries on.
 * @param {{
 *   order?: readonly string[],
 *   cursor: { write: (alias: string) => Promise<unknown> },
 *   runnableIssues: (alias: string) => Promise<number[]>,
 *   pastSuggestions: (alias: string) => Promise<SuggestedIssue[]>,
 *   explore: (target: { alias: string, pastSuggestions: SuggestedIssue[] }) => Promise<string>,
 * }} deps `runnableIssues`: none means idle, else the skip line names them. `explore`: the
 *   explore-and-file step, e.g. `runRepoInsight` with its deps bound
 * @returns {Promise<{ lines: string[], failed: number }>}
 */
export async function sweepRepoInsight({ order = REPO_INSIGHT_PRIORITY, cursor, runnableIssues, pastSuggestions, explore }) {
  const lines = [];
  let failed = 0;
  for (const alias of order) {
    try {
      const runnable = await runnableIssues(alias);
      if (!runnable.length) lines.push(await explore({ alias, pastSuggestions: await pastSuggestions(alias) }));
      else lines.push(`repo-insight: ${alias} → not idle (runnable: ${runnable.map((n) => `#${n}`).join(', ')}), skipped`);
    } catch (err) {
      failed++;
      lines.push(`repo-insight: ${alias} → failed (${/** @type {Error} */ (err).message})`);
    }
    await cursor.write(alias);
  }
  lines.push(`repo-insight: sweep done, cursor on ${order[order.length - 1]}${failed ? `, ${failed} failed` : ''}`);
  return { lines, failed };
}
