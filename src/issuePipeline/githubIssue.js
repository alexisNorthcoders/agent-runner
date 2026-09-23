import { parseCompactMap } from '../workspaces.js';

/**
 * Reads a GitHub issue with `gh` and renders it as the agent's prompt. Which repo the issue lives
 * in comes from `CLAUDE_ISSUE_REPO_MAP` for the alias, else the workspace's GitHub `origin`. Also
 * the cron's repo-wide lookups: open issues, their `blocked_by` count, and open agent PRs.
 *
 * @typedef {{ number: number, title: string, labels: string[] }} OpenIssue
 * @typedef {{ url: string, headSha: string, baseRefName: string, mergeable: string, mergeStateStatus: string }} OpenAgentPr
 */

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const RETRY_BACKOFF_MS = [0, 2500, 8000];
const ISSUE_LIST_LIMIT = 500;

/** @param {string} repo @returns {string} */
function assertRepoSlug(repo) {
  if (!REPO_SLUG_RE.test(String(repo))) throw new Error(`GitHub repo must look like owner/repo (got ${JSON.stringify(repo)})`);
  return repo;
}

/** @param {any[] | undefined} labels @returns {string[]} */
const labelNames = (labels) => (Array.isArray(labels) ? labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : []);

/**
 * Issue number in an agent issue branch name (`<prefix>-<n>-<slug>`), or null for other branches.
 * @param {string} headRefName
 * @param {string} prefix `CLAUDE_ISSUE_BRANCH_PREFIX`
 * @returns {number | null}
 */
export function issueNumberFromAgentBranch(headRefName, prefix) {
  const head = String(headRefName || '');
  if (!head.startsWith(`${prefix}-`)) return null;
  const m = /^(\d+)(?:-|$)/.exec(head.slice(prefix.length + 1));
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * True for gateway / rate-limit / network errors from `gh`, which are worth retrying.
 * @param {string} combinedMessage stderr + message from a failed `gh` invocation
 */
export function githubCliErrorLooksTransient(combinedMessage) {
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
 * @param {string} remoteUrl output of `git remote get-url origin`
 * @returns {string | null} `owner/repo`
 */
export function ownerRepoSlugFromGithubRemote(remoteUrl) {
  const u = String(remoteUrl || '').trim();
  const m = u.match(/^git@github\.com:([^/]+)\/([^/]+)$/i) || u.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}

/**
 * Render a `gh issue view --json` payload as the prompt markdown. Post-run reads `# GitHub issue #n`,
 * `**Title:**` and `**Labels:**` back out of it for the commit message.
 * @param {{ number?: number, title?: string, body?: string, state?: string, url?: string, labels?: any[] }} data
 * @param {{ repo: string, number: number, extraInstructions?: string }} p
 */
export function renderIssuePrompt(data, { repo, number, extraInstructions = '' }) {
  const labels = labelNames(data.labels);
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

/**
 * @param {{
 *   exec: import('./exec.js').Exec,
 *   settings: import('./settings.js').PipelineSettings,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 */
export function createGithubIssues({ exec, settings, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /** `gh` with a couple of retries on transient GitHub errors. @param {string[]} args */
  async function ghWithRetry(args) {
    let lastErr;
    for (const wait of RETRY_BACKOFF_MS) {
      if (wait) await sleep(wait);
      try {
        return await exec('gh', args, { maxBuffer: 4 * 1024 * 1024 });
      } catch (e) {
        lastErr = e;
        if (e?.code === 'ENOENT' || !githubCliErrorLooksTransient(`${e?.stderr || ''} ${e?.message || e}`)) break;
      }
    }
    throw lastErr;
  }

  /**
   * @param {string} workspaceRoot
   * @param {string | null} alias
   * @returns {Promise<string>} `owner/repo`
   */
  async function resolveIssueRepo(workspaceRoot, alias) {
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

  /** @param {string[]} args @returns {Promise<string>} stdout */
  async function gh(args) {
    try {
      return (await ghWithRetry(args)).stdout;
    } catch (e) {
      throw new Error(
        e?.code === 'ENOENT'
          ? 'GitHub CLI not found. Install gh or set GH_BIN to its full path.'
          : (typeof e?.stderr === 'string' && e.stderr.trim()) || e?.message || String(e)
      );
    }
  }

  return {
    resolveIssueRepo,

    /** @param {string} repo @returns {Promise<OpenIssue[]>} */
    async listOpenIssues(repo) {
      const out = await gh(['issue', 'list', '--repo', assertRepoSlug(repo), '--state', 'open', '--json', 'number,title,labels', '--limit', String(ISSUE_LIST_LIMIT)]);
      const data = JSON.parse(out || '[]');
      if (!Array.isArray(data)) return [];
      return data
        .map((row) => ({ number: Number(row?.number), title: String(row?.title ?? ''), labels: labelNames(row?.labels) }))
        .filter((row) => Number.isInteger(row.number) && row.number > 0);
    },

    /**
     * Open blockers of an issue, from GitHub's native issue dependencies (GitHub recomputes it as
     * blockers close).
     * @param {string} repo
     * @param {number} issueNumber
     */
    async blockedByCount(repo, issueNumber) {
      const out = await gh(['api', `repos/${assertRepoSlug(repo)}/issues/${issueNumber}`, '--jq', '.issue_dependencies_summary.blocked_by // 0']);
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    },

    /**
     * Open PRs whose head is an agent issue branch, keyed by issue number.
     * @param {string} repo
     * @returns {Promise<Map<number, OpenAgentPr>>}
     */
    async listOpenAgentPrsByIssue(repo) {
      const out = await gh(['pr', 'list', '--repo', assertRepoSlug(repo), '--state', 'open', '--json', 'url,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus', '--limit', '100']);
      const data = JSON.parse(out || '[]');
      /** @type {Map<number, OpenAgentPr>} */
      const byIssue = new Map();
      if (!Array.isArray(data)) return byIssue;
      for (const row of data) {
        const n = issueNumberFromAgentBranch(row?.headRefName, settings.issueBranchPrefix);
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

    /** Current tip commit of `branch` on GitHub. @param {string} repo @param {string} branch */
    async branchHeadSha(repo, branch) {
      return (await gh(['api', `repos/${assertRepoSlug(repo)}/branches/${encodeURIComponent(branch)}`, '--jq', '.commit.sha'])).trim();
    },

    /**
     * @param {{ issueNumber: number, workspaceRoot: string, alias: string | null, extraInstructions?: string }} p
     * @returns {Promise<{ markdown: string, repo: string, number: number, title: string }>}
     */
    async fetchIssuePrompt({ issueNumber, workspaceRoot, alias, extraInstructions = '' }) {
      const repo = await resolveIssueRepo(workspaceRoot, alias);
      const stdout = await gh(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'title,body,number,state,url,labels']);
      let data;
      try {
        data = JSON.parse(stdout);
      } catch (err) {
        throw new Error(`gh returned invalid JSON: ${err.message}`);
      }
      return {
        markdown: renderIssuePrompt(data, { repo, number: issueNumber, extraInstructions }),
        repo,
        number: typeof data.number === 'number' ? data.number : issueNumber,
        title: data.title ?? '',
      };
    },
  };
}
