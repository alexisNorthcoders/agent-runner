/**
 * Reads a GitHub issue with `gh` and renders it as the agent's prompt. Which repo the issue lives
 * in comes from `CLAUDE_ISSUE_REPO_MAP` for the alias, else the workspace's GitHub `origin`. Also
 * the cron's repo-wide lookups: open issues, their `blocked_by` count, and open agent PRs.
 */

import { parseCompactMap } from '../workspaces.ts';
import { errorText, isRecord, numberOrNull, recordOrEmpty, stringOrNull } from '../narrow.ts';
import type { Exec } from './exec.ts';
import type { PipelineSettings } from './settings.ts';

export type OpenIssue = { number: number; title: string; labels: string[] };

export type SuggestedIssue = { number: number; title: string; url: string; state: 'open' | 'closed'; labels: string[] };

export type TriageSuggestion = { number: number; title: string; url: string; createdAt: string; comments: string[]; /** Each comment's link, in the same order as `comments`. */ commentUrls?: string[] };

export type IssueDetail = { number: number; title: string; url: string; state: 'open' | 'closed'; labels: string[]; comments: string[]; /** Each comment's link, in the same order as `comments`. */ commentUrls?: string[] };

export type OpenAgentPr = { url: string; headSha: string; baseRefName: string; mergeable: string; mergeStateStatus: string };

/** The fields of `gh issue view --json title,body,number,state,url,labels` that the prompt uses. */
type IssueView = { number: number | null; title: string | null; body: string | null; state: string | null; url: string | null; labels: string[] };

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const RETRY_BACKOFF_MS = [0, 2500, 8000];
const ISSUE_LIST_LIMIT = 500;
export const AGENT_SUGGESTED_LABEL = 'agent-suggested';
export const NEEDS_TRIAGE_LABEL = 'needs-triage';
export const WONTFIX_LABEL = 'wontfix';

function assertRepoSlug(repo: string): string {
  if (!REPO_SLUG_RE.test(String(repo))) throw new Error(`GitHub repo must look like owner/repo (got ${JSON.stringify(repo)})`);
  return repo;
}

const commentBodies = (comments: unknown): string[] =>
  Array.isArray(comments) ? comments.map((c) => recordOrEmpty(c).body).filter((body): body is string => typeof body === 'string') : [];

const commentUrls = (comments: unknown): string[] =>
  Array.isArray(comments) ? comments.map((c) => String(recordOrEmpty(c).url ?? '')) : [];

const labelNames = (labels: unknown): string[] =>
  Array.isArray(labels)
    ? labels.map((l) => (typeof l === 'string' ? l : recordOrEmpty(l).name)).filter((name): name is string => typeof name === 'string' && name !== '')
    : [];

/** A failed `gh` call's trimmed stderr, else its message. */
function ghErrorText(e: unknown): string {
  const { stderr } = recordOrEmpty(e);
  return (typeof stderr === 'string' && stderr.trim()) || errorText(e);
}

/** `gh … --json` list output as rows. Empty output is an empty list; invalid JSON throws. */
function ghJsonRows(out: string): unknown[] {
  const data: unknown = JSON.parse(out || '[]');
  return Array.isArray(data) ? data : [];
}

function parseIssueView(raw: string): IssueView {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`gh returned invalid JSON: ${errorText(err)}`);
  }
  if (!isRecord(data)) throw new Error('gh returned invalid JSON: not an object');
  return {
    number: numberOrNull(data.number),
    title: stringOrNull(data.title),
    body: stringOrNull(data.body),
    state: stringOrNull(data.state),
    url: stringOrNull(data.url),
    labels: labelNames(data.labels),
  };
}

/**
 * Issue number in an agent issue branch name (`<prefix>-<n>-<slug>`), or null for other branches.
 * @param prefix `CLAUDE_ISSUE_BRANCH_PREFIX`
 */
export function issueNumberFromAgentBranch(headRefName: string, prefix: string): number | null {
  const head = String(headRefName || '');
  if (!head.startsWith(`${prefix}-`)) return null;
  const m = /^(\d+)(?:-|$)/.exec(head.slice(prefix.length + 1));
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * True for gateway / rate-limit / network errors from `gh`, which are worth retrying.
 * @param combinedMessage stderr + message from a failed `gh` invocation
 */
export function githubCliErrorLooksTransient(combinedMessage: string) {
  const m = String(combinedMessage || '').toLowerCase();
  return (
    /\b50[234]\b/.test(m) ||
    /\b429\b/.test(m) ||
    m.includes('gateway timeout') ||
    m.includes('bad gateway') ||
    m.includes('service unavailable') ||
    m.includes('econnreset') ||
    m.includes('socket hang up') ||
    m.includes('etimedout') ||
    m.includes('network error') ||
    (m.includes('timeout') && m.includes('http'))
  );
}

/**
 * @param remoteUrl output of `git remote get-url origin`
 * @returns `owner/repo`
 */
export function ownerRepoSlugFromGithubRemote(remoteUrl: string): string | null {
  const u = String(remoteUrl || '').trim();
  const m = u.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) || u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}

/**
 * Render a `gh issue view --json` payload as the prompt markdown. Post-run reads `# GitHub issue #n`,
 * `**Title:**` and `**Labels:**` back out of it for the commit message.
 */
function renderIssuePrompt(data: IssueView, { repo, number, extraInstructions = '' }: { repo: string; number: number; extraInstructions?: string }) {
  const { labels } = data;
  const lines = [
    `# GitHub issue #${data.number ?? number}`,
    '',
    `**Repository:** ${repo}`,
    `**URL:** ${data.url ?? ''}`,
    `**State:** ${data.state ?? ''}`,
  ];
  if (labels.length) lines.push(`**Labels:** ${labels.join(', ')}`);
  lines.push(`**Title:** ${data.title ?? ''}`, '', '## Body', (data.body || '').trim() || '_(empty)_');
  const extra = extraInstructions.trim();
  if (extra) lines.push('', '## Additional instructions (from WhatsApp)', extra);
  return lines.join('\n');
}

export function createGithubIssues({ exec, settings, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: {
    exec: Exec;
    settings: PipelineSettings;
    sleep?: (ms: number) => Promise<void>;
  }) {
  /** `gh` with a couple of retries on transient GitHub errors. */
  async function ghWithRetry(args: string[]) {
    let lastErr: unknown;
    for (const wait of RETRY_BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        return await exec('gh', args, { maxBuffer: 4 * 1024 * 1024 });
      } catch (e) {
        lastErr = e;
        const { code, stderr } = recordOrEmpty(e);
        if (code === 'ENOENT' || !githubCliErrorLooksTransient(`${typeof stderr === 'string' ? stderr : ''} ${errorText(e)}`)) break;
      }
    }
    throw lastErr;
  }

  /**
   * @returns `owner/repo`
   */
  async function resolveIssueRepo(workspaceRoot: string, alias: string | null): Promise<string> {
    const mapped = alias ? parseCompactMap(settings.issueRepoMap).get(alias) : undefined;
    if (mapped) {
      if (!REPO_SLUG_RE.test(mapped)) throw new Error(`CLAUDE_ISSUE_REPO_MAP entry for "${alias}" must look like owner/repo (got "${mapped}")`);
      return mapped;
    }
    let origin = '';
    try {
      origin = (await exec('git', ['remote', 'get-url', 'origin'], { cwd: workspaceRoot })).stdout;
    } catch {
      /* no origin */
    }
    const slug = ownerRepoSlugFromGithubRemote(origin);
    if (slug && REPO_SLUG_RE.test(slug)) return slug;
    throw new Error(
      `Cannot tell which GitHub repo ${workspaceRoot} belongs to: its origin is not a GitHub URL. Add it to CLAUDE_ISSUE_REPO_MAP (${alias ?? '<alias>'}=owner/repo).`
    );
  }

  async function gh(args: string[]): Promise<string> {
    try {
      return (await ghWithRetry(args)).stdout;
    } catch (e) {
      throw new Error(recordOrEmpty(e).code === 'ENOENT' ? 'GitHub CLI not found. Install gh or set GH_BIN to its full path.' : ghErrorText(e));
    }
  }

  return {
    resolveIssueRepo,

    async listOpenIssues(repo: string): Promise<OpenIssue[]> {
      const out = await gh(['issue', 'list', '--repo', assertRepoSlug(repo), '--state', 'open', '--json', 'number,title,labels', '--limit', String(ISSUE_LIST_LIMIT)]);
      return ghJsonRows(out)
        .map(recordOrEmpty)
        .map((row): OpenIssue => ({ number: Number(row.number), title: String(row.title ?? ''), labels: labelNames(row.labels) }))
        .filter((row) => Number.isInteger(row.number) && row.number > 0);
    },

    /**
     * Issues labelled `agent-suggested`, open and closed (whatever their outcome).
     */
    async listAgentSuggestedIssues(repo: string): Promise<SuggestedIssue[]> {
      const out = await gh(['issue', 'list', '--repo', assertRepoSlug(repo), '--label', AGENT_SUGGESTED_LABEL, '--state', 'all', '--json', 'number,title,url,state,labels', '--limit', String(ISSUE_LIST_LIMIT)]);
      return ghJsonRows(out)
        .map(recordOrEmpty)
        .map((row): SuggestedIssue => ({
          number: Number(row.number),
          title: String(row.title ?? ''),
          url: String(row.url ?? ''),
          state: String(row.state ?? '').toLowerCase() === 'open' ? 'open' : 'closed',
          labels: labelNames(row.labels),
        }))
        .filter((row) => Number.isInteger(row.number) && row.number > 0);
    },

    /**
     * Open issues labelled both `agent-suggested` and `needs-triage`, with their comment bodies.
     */
    async listTriageSuggestions(repo: string): Promise<TriageSuggestion[]> {
      const out = await gh(['issue', 'list', '--repo', assertRepoSlug(repo), '--label', AGENT_SUGGESTED_LABEL, '--label', NEEDS_TRIAGE_LABEL, '--state', 'open', '--json', 'number,title,url,createdAt,comments', '--limit', String(ISSUE_LIST_LIMIT)]);
      return ghJsonRows(out)
        .map(recordOrEmpty)
        .map((row): TriageSuggestion => ({
          number: Number(row.number),
          title: String(row.title ?? ''),
          url: String(row.url ?? ''),
          createdAt: String(row.createdAt ?? ''),
          comments: commentBodies(row.comments),
          commentUrls: commentUrls(row.comments),
        }))
        .filter((row) => Number.isInteger(row.number) && row.number > 0);
    },

    /** The bodies of an issue's comments, oldest first. */
    async issueCommentBodies(repo: string, issueNumber: number): Promise<string[]> {
      const out = await gh(['issue', 'view', String(issueNumber), '--repo', assertRepoSlug(repo), '--json', 'comments']);
      return commentBodies(recordOrEmpty(JSON.parse(out || '{}')).comments);
    },

    /** One issue with its labels and comment bodies (oldest first). */
    async issueDetail(repo: string, issueNumber: number): Promise<IssueDetail> {
      const out = await gh(['issue', 'view', String(issueNumber), '--repo', assertRepoSlug(repo), '--json', 'number,title,url,state,labels,comments']);
      const row = recordOrEmpty(JSON.parse(out || '{}'));
      return {
        number: Number(row.number) || issueNumber,
        title: String(row.title ?? ''),
        url: String(row.url ?? ''),
        state: String(row.state ?? '').toLowerCase() === 'open' ? 'open' : 'closed',
        labels: labelNames(row.labels),
        comments: commentBodies(row.comments),
        commentUrls: commentUrls(row.comments),
      };
    },

    /** Label an issue `wontfix` and close it as not planned. */
    async rejectIssue(repo: string, issueNumber: number): Promise<void> {
      assertRepoSlug(repo);
      await gh(['issue', 'edit', String(issueNumber), '--repo', repo, '--add-label', WONTFIX_LABEL]);
      await gh(['issue', 'close', String(issueNumber), '--repo', repo, '--reason', 'not planned']);
    },

    /**
     * File a new issue.
     */
    async createIssue(repo: string, { title, body, labels }: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string; title: string }> {
      assertRepoSlug(repo);
      // `gh issue create --label` refuses a label the repo doesn't have, so create any missing ones first
      if (labels.length) {
        const out = await gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', '1000']);
        const have = new Set(labelNames(ghJsonRows(out)).map((name) => name.toLowerCase()));
        for (const label of labels) {
          if (have.has(label.toLowerCase())) continue;
          try {
            await gh(['label', 'create', label, '--repo', repo]);
          } catch (e) {
            if (!/already exists/i.test(errorText(e))) throw new Error(`could not create label ${label}: ${errorText(e)}`);
          }
        }
      }
      const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
      for (const label of labels) args.push('--label', label);
      // not retried: a retry after a timed-out success could file a duplicate
      let stdout;
      try {
        stdout = (await exec('gh', args, { maxBuffer: 4 * 1024 * 1024 })).stdout;
      } catch (e) {
        throw new Error(ghErrorText(e));
      }
      const url = stdout.trim().split('\n').pop() ?? '';
      const m = /\/issues\/(\d+)$/.exec(url);
      if (!m) throw new Error(`gh issue create printed no issue URL: ${JSON.stringify(stdout.trim().slice(0, 200))}`);
      return { number: parseInt(m[1], 10), url, title };
    },

    /**
     * Open blockers of an issue, from GitHub's native issue dependencies (GitHub recomputes it as
     * blockers close).
     */
    async blockedByCount(repo: string, issueNumber: number) {
      const out = await gh(['api', `repos/${assertRepoSlug(repo)}/issues/${issueNumber}`, '--jq', '.issue_dependencies_summary.blocked_by // 0']);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },

    /**
     * Open PRs whose head is an agent issue branch, keyed by issue number.
     */
    async listOpenAgentPrsByIssue(repo: string): Promise<Map<number, OpenAgentPr>> {
      const out = await gh(['pr', 'list', '--repo', assertRepoSlug(repo), '--state', 'open', '--json', 'url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus', '--limit', '100']);
      const byIssue: Map<number, OpenAgentPr> = new Map();
      for (const row of ghJsonRows(out).map(recordOrEmpty)) {
        const n = issueNumberFromAgentBranch(String(row.headRefName || ''), settings.issueBranchPrefix);
        if (n == null || byIssue.has(n)) continue;
        byIssue.set(n, {
          url: String(row.url || ''),
          headSha: String(row.headRefOid || ''),
          baseRefName: String(row.baseRefName || ''),
          mergeable: String(row.mergeable || ''),
          mergeStateStatus: String(row.mergeStateStatus || ''),
        });
      }
      return byIssue;
    },

    /** Current tip commit of `branch` on GitHub. */
    async branchHeadSha(repo: string, branch: string) {
      return (await gh(['api', `repos/${assertRepoSlug(repo)}/branches/${encodeURIComponent(branch)}`, '--jq', '.commit.sha'])).trim();
    },

    async fetchIssuePrompt({ issueNumber, workspaceRoot, alias, extraInstructions = '' }: { issueNumber: number; workspaceRoot: string; alias: string | null; extraInstructions?: string }): Promise<{ markdown: string; repo: string; number: number; title: string; labels: string[] }> {
      const repo = await resolveIssueRepo(workspaceRoot, alias);
      const stdout = await gh(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'title,body,number,state,url,labels']);
      const view = parseIssueView(stdout);
      return {
        markdown: renderIssuePrompt(view, { repo, number: issueNumber, extraInstructions }),
        repo,
        number: view.number ?? issueNumber,
        title: view.title ?? '',
        labels: view.labels,
      };
    },
  };
}
