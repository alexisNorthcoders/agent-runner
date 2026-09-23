import { parseCompactMap } from '../workspaces.js';

/**
 * Reads a GitHub issue with `gh` and renders it as the agent's prompt. Which repo the issue lives
 * in comes from `CLAUDE_ISSUE_REPO_MAP` for the alias, else the workspace's GitHub `origin`.
 */

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const RETRY_BACKOFF_MS = [0, 2500, 8000];

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
  const labels = Array.isArray(data.labels) ? data.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
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

  return {
    resolveIssueRepo,
    /**
     * @param {{ issueNumber: number, workspaceRoot: string, alias: string | null, extraInstructions?: string }} p
     * @returns {Promise<{ markdown: string, repo: string, number: number, title: string }>}
     */
    async fetchIssuePrompt({ issueNumber, workspaceRoot, alias, extraInstructions = '' }) {
      const repo = await resolveIssueRepo(workspaceRoot, alias);
      let stdout;
      try {
        ({ stdout } = await ghWithRetry(['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'title,body,number,state,url,labels']));
      } catch (e) {
        throw new Error(
          e?.code === 'ENOENT'
            ? 'GitHub CLI not found. Install gh or set GH_BIN to its full path.'
            : (typeof e?.stderr === 'string' && e.stderr.trim()) || e?.message || String(e)
        );
      }
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
