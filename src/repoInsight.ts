/**
 * Rotation for `repo_insight`: which workspace to visit next. Pure decision-making plus the
 * cursor's persistence; no GitHub calls or agent sessions.
 *
 * - `agent-runner:repo-insight:cursor` (string): the alias last visited.
 */

import { classifyReadyIssues } from './cronTracer.ts';
import { errorText, recordOrEmpty } from './narrow.ts';
import type { SuggestedIssue, createGithubIssues } from './issuePipeline/githubIssue.ts';
import type { Store } from './redisStore.ts';

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
  'monitor-canvas',
];

/**
 * The next idle workspace: walk forward from just after the cursor, wrapping around the end. A
 * cursor that isn't in the order (or is null) starts from the top. The cursor itself is the last
 * candidate, so a lone idle workspace is picked again. `idle`: alias → idle. `cursor`: the alias
 * last visited. Null when no workspace is idle.
 */
export function pickNextIdleWorkspace(order: readonly string[], idle: Readonly<Record<string, boolean>> | ReadonlyMap<string, boolean>, cursor: string | null): string | null {
  const isIdle = (alias: string) => (isMap(idle) ? idle.get(alias) : idle[alias]) === true;
  return rotationFrom(order, cursor).find(isIdle) ?? null;
}

const isMap = (v: object): v is ReadonlyMap<string, boolean> => v instanceof Map;

/**
 * The order the picker visits workspaces in: just after the cursor, wrapping, the cursor last.
 * A cursor that isn't in the order (or is null) starts from the top.
 */
export function rotationFrom(order: readonly string[], cursor: string | null): string[] {
  const start = cursor == null ? -1 : order.indexOf(cursor);
  return order.map((_, i) => order[(start + 1 + i) % order.length]);
}

/**
 * Today's target: check workspaces in rotation order, lazily, until one is idle. The cursor is
 * persisted the moment one is found, before its past suggestions are fetched, so a later failure
 * doesn't skip it next time. Nothing idle leaves the cursor alone. Takes no agent action and
 * writes nothing to GitHub. Null when nothing is idle.
 */
export async function decideRepoInsightTarget({ order = REPO_INSIGHT_PRIORITY, cursor, isIdle, pastSuggestions }: {
    order?: readonly string[];
    cursor: { read: () => Promise<string | null>; write: (alias: string) => Promise<unknown> };
    isIdle: (alias: string) => Promise<boolean>;
    pastSuggestions: (alias: string) => Promise<SuggestedIssue[]>;
  }): Promise<{ alias: string; pastSuggestions: SuggestedIssue[] } | null> {
  for (const alias of rotationFrom(order, await cursor.read())) {
    if (!(await isIdle(alias))) continue;
    await cursor.write(alias);
    return { alias, pastSuggestions: await pastSuggestions(alias) };
  }
  return null;
}

export function createRepoInsightCursor({ store }: { store: Store }) {
  return {
    /** The alias last visited. */
    async read(): Promise<string | null> {
      const v = await store.get(REPO_INSIGHT_CURSOR_KEY);
      return v ? v : null;
    },

    async write(alias: string) {
      if (typeof alias !== 'string' || !alias) throw new TypeError(`repo insight: invalid alias ${JSON.stringify(alias)}`);
      await store.set(REPO_INSIGHT_CURSOR_KEY, alias);
    },
  };
}

/**
 * Read-only GitHub lookups for `repo_insight`, behind an injectable `github` (the same shape the
 * issue scan takes, plus `listAgentSuggestedIssues`). `prAttempts`: the cron's recorded PR attempts
 * (`cronState.prAttempts`), read only.
 */
export function createRepoInsightLookups({ workspaces, github, prAttempts }: {
    workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha' | 'listAgentSuggestedIssues'>;
    prAttempts: () => Promise<Map<string, string>>;
  }) {
  const repoOf = async (alias: string) => github.resolveIssueRepo((await workspaces.resolveIssueWorkspace(alias)).root, alias);

  /**
   * The issues in the cron tracer's `runnable` bucket (ready-for-agent, not blocked, not parked
   * behind an attempted open PR), ascending. Throws when GitHub can't be read.
   */
  async function runnableIssues(alias: string): Promise<number[]> {
    const repo = await repoOf(alias);
    const rows = await github.listOpenIssues(repo);
    const { runnable } = await classifyReadyIssues(github, repo, rows, await prAttempts());
    return runnable.map((r) => r.number);
  }

  return {
    runnableIssues,

    /**
     * Idle: no runnable issue (see `runnableIssues`), whoever is or isn't working on them.
     */
    async isIdle(alias: string) {
      return (await runnableIssues(alias)).length === 0;
    },

    /**
     * The repo's `agent-suggested` issues, open and closed, so a new suggestion doesn't repeat one.
     */
    async pastSuggestions(alias: string) {
      return github.listAgentSuggestedIssues(await repoOf(alias));
    },
  };
}

/**
 * The prompt of the read-only exploration session: the past suggestions go in so it doesn't
 * repeat one, open or closed.
 */
export function buildInsightPrompt({ alias, pastSuggestions }: { alias: string; pastSuggestions: SuggestedIssue[] }) {
  const past = pastSuggestions.length
    ? pastSuggestions.map((s) => `- #${s.number} [${s.state}] ${s.title}`).join('\n')
    : '_(none yet)_';
  return [
    `You are exploring the "${alias}" repository (your working directory) to pitch ONE idea that would make it more exciting.`,
    'You are read-only: you can read and search files, nothing else. Do not try to edit, run commands or file anything.',
    '',
    'This is a personal side project. The owner wants ideas that make them say "oh, that would be cool": new features,',
    'new capabilities, delightful UX, clever uses of the data it already has, or integrations that open up something new.',
    'Do NOT suggest tests, CI, input validation, error handling, refactors, logging or other hardening; those are not wanted here.',
    '',
    'First work out what the project is for and who uses it (README, entry points, key modules). Then brainstorm five ideas,',
    'each from a different angle: a new feature, a UX or delight upgrade, something built on data or state the project already has,',
    'an integration, and one ambitious stretch idea. Pick the most exciting one that a coding agent could still ship in a single pull request.',
    '',
    'It must not repeat any idea already raised here, whether that issue is still open or was closed, and should steer away from the themes they cover:',
    '',
    past,
    '',
    'You may think out loud briefly, but end your reply with a JSON object:',
    '{"title": "<short, specific issue title>", "body": "<markdown issue body: why it would be exciting, what it would look like to use, the proposed change grounded in the current code, acceptance criteria>"}',
  ].join('\n');
}

/**
 * Pull `{ title, body }` out of the session's final text (which may wrap the JSON in prose or a fence).
 */
export function parseInsightIdea(text: string): { title: string; body: string } {
  const s = String(text ?? '');
  for (let end = s.lastIndexOf('}'); end > 0; end = s.lastIndexOf('}', end - 1)) {
    for (let start = s.indexOf('{'); start >= 0 && start < end; start = s.indexOf('{', start + 1)) {
      try {
        const o = recordOrEmpty(JSON.parse(s.slice(start, end + 1)));
        const title = typeof o.title === 'string' ? o.title.trim().replace(/\s+/g, ' ') : '';
        const body = typeof o.body === 'string' ? o.body.trim() : '';
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
 */
export async function runRepoInsight({ target, resolveWorkspace, resolveRepo, launchSession, createIssue }: {
    target: { alias: string; pastSuggestions: SuggestedIssue[] } | null;
    resolveWorkspace: (alias: string) => Promise<{ root: string }>;
    resolveRepo: (root: string, alias: string) => Promise<string>;
    launchSession: (p: { cwd: string; prompt: string }) => Promise<{ text: string }>;
    createIssue: (repo: string, p: { title: string; body: string; labels: string[] }) => Promise<{ number: number; url: string; title: string }>;
  }): Promise<string> {
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
 * `runnableIssues`: none means idle, else the skip line names them. `explore`: the
 * explore-and-file step, e.g. `runRepoInsight` with its deps bound.
 */
export async function sweepRepoInsight({ order = REPO_INSIGHT_PRIORITY, cursor, runnableIssues, pastSuggestions, explore }: {
    order?: readonly string[];
    cursor: { write: (alias: string) => Promise<unknown> };
    runnableIssues: (alias: string) => Promise<number[]>;
    pastSuggestions: (alias: string) => Promise<SuggestedIssue[]>;
    explore: (target: { alias: string; pastSuggestions: SuggestedIssue[] }) => Promise<string>;
  }): Promise<{ lines: string[]; failed: number }> {
  const lines: string[] = [];
  let failed = 0;
  for (const alias of order) {
    try {
      const runnable = await runnableIssues(alias);
      if (!runnable.length) lines.push(await explore({ alias, pastSuggestions: await pastSuggestions(alias) }));
      else lines.push(`repo-insight: ${alias} → not idle (runnable: ${runnable.map((n) => `#${n}`).join(', ')}), skipped`);
    } catch (err) {
      failed++;
      lines.push(`repo-insight: ${alias} → failed (${errorText(err)})`);
    }
    await cursor.write(alias);
  }
  lines.push(`repo-insight: sweep done, cursor on ${order[order.length - 1]}${failed ? `, ${failed} failed` : ''}`);
  return { lines, failed };
}
