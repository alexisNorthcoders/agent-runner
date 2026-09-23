import { git, execErrorText } from './exec.js';

/**
 * Git work in the target repo for an issue run. Issue runs branch **in place** in the live
 * checkout (WhatsappBot ADR 0001): prep leaves it on `<prefix>-<n>-<slug>`, post-run commits and
 * pushes that branch, and after a merge the repo goes back to its default branch (`main` or
 * `master`, whichever origin uses).
 */

const COMMIT_SUBJECT_MAX = 72;

/** UTC stamp safe for git branch names (no colons). @param {Date} d */
function branchTimestampUtc(d) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}-${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}`;
}

const randomBranchSuffix = () =>
  Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');

/** @param {string} title */
export function slugifyForGitBranch(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'work';
}

/**
 * @param {string} s
 * @param {number} max
 */
export function truncate(s, max) {
  const t = String(s);
  return t.length <= max ? t : `${t.slice(0, max)}\n\n[… truncated at ${max} characters …]\n`;
}

/** Issue number from the `# GitHub issue #n` heading of the rendered issue prompt. @param {string} userPrompt */
function extractGithubIssueNumber(userPrompt) {
  const m = String(userPrompt || '').match(/^#\s*GitHub issue\s+#(\d+)/im);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Short description from the prompt: the issue title, else the first instruction line, else the
 * changed file names.
 * @param {string} userPrompt
 * @param {string[]} paths
 */
function extractCommitDescriptionHint(userPrompt, paths) {
  const raw = String(userPrompt || '');
  const titleMatch = raw.match(/^\*\*Title:\*\*\s*(.+)$/m);
  let hint = '';
  if (titleMatch) {
    hint = titleMatch[1].trim().replace(/\s*\(#\d+\)\s*$/, '').trim();
  } else {
    const noise = /^(#|---|\*\*|source:|repository:|url:|state:|labels?:|body|claude)/i;
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (noise.test(line)) continue;
      hint = line.replace(/^[-*]\s+/, '').trim();
      if (hint) break;
    }
  }
  if (!hint) {
    const names = paths.map((p) => {
      const base = p.split('/').pop() || p;
      return base.length > 40 ? `${base.slice(0, 37)}…` : base;
    });
    if (!names.length) return 'update';
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names[0]}, ${names[1]} (+${names.length - 2})`;
  }
  return hint.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
}

/**
 * Conventional-commit type from the changed paths, the issue labels and the prompt wording.
 * @param {string[]} paths
 * @param {string} userPrompt
 */
export function inferConventionalCommitType(paths, userPrompt) {
  const prompt = String(userPrompt || '').toLowerCase();
  if (paths.length > 0 && paths.every((p) => /\.md$/i.test(p))) return 'docs';
  const testPaths =
    paths.length > 0 &&
    paths.every((p) => /(?:^|\/)__tests__\//i.test(p) || /(?:^|\/)(tests?|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(p));
  if (testPaths) return 'test';
  const labels = (String(userPrompt || '').match(/^\*\*Labels:\*\*\s*(.+)$/im)?.[1] || '').toLowerCase();
  if (labels.includes('bug') || labels.includes('fix')) return 'fix';
  if (labels.includes('documentation') || labels.includes('docs')) return 'docs';
  if (/\b(fix|fixes|fixed|bug|bugs|broken|regression|crash|patch|resolve|closes)\b/.test(prompt)) return 'fix';
  if (/\b(refactor|cleanup|restructure|rename)\b/.test(prompt)) return 'refactor';
  if (/\b(feat|feature|add |adds |adding |implement|introduces?|new api)\b/.test(prompt) || /\bfeat(\(.+?\))?:/.test(prompt)) return 'feat';
  if (paths.some((p) => /(^|\/)\.github\//i.test(p) || /package-lock\.json$/i.test(p))) return 'chore';
  return 'feat';
}

/**
 * One-line conventional-commit subject (no LLM), e.g. `fix: stop the crash (#12)`.
 * @param {string} nameOnlyStdout `git diff --name-only` output
 * @param {string} [userPrompt]
 */
export function buildCommitMessage(nameOnlyStdout, userPrompt = '') {
  const paths = String(nameOnlyStdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const type = inferConventionalCommitType(paths, userPrompt);
  const desc = extractCommitDescriptionHint(userPrompt, paths) || 'update';
  const issueNum = extractGithubIssueNumber(userPrompt);
  const suffix = issueNum != null ? ` (#${issueNum})` : '';
  const line = `${type}: ${desc}${suffix}`;
  if (line.length <= COMMIT_SUBJECT_MAX) return line;
  const maxDesc = COMMIT_SUBJECT_MAX - (`${type}: `.length + suffix.length + 1);
  return `${type}: ${maxDesc >= 12 ? `${desc.slice(0, maxDesc - 1)}…` : desc.slice(0, 12)}${suffix}`;
}

/** The WIP commit subject, distinct from real commits in `git log`. @param {number} issueNumber */
export const wipCommitMessage = (issueNumber) => `chore: WIP snapshot (issue #${issueNumber}, agent run interrupted)`;

/**
 * @typedef {{ ok: boolean, sha?: string, message?: string, reason?: string, error?: string }} CommitResult
 * @typedef {{ dirty: boolean, headMoved: boolean, porcelain: string, waitedMs: number, polls: number }} GitActivity
 */

/**
 * @param {{
 *   exec: import('./exec.js').Exec,
 *   settings: import('./settings.js').PipelineSettings,
 *   log?: (message: string, detail?: unknown) => void,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} deps
 */
export function createGitWorkspace({ exec, settings, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  /** @param {string[]} args @param {string} repo */
  const run = (args, repo) => git(exec, args, repo);

  /** @param {string} repo */
  const statusPorcelain = async (repo) => (await run(['status', '--porcelain'], repo)).stdout.trim();
  /** @param {string} repo */
  const headSha = async (repo) => (await run(['rev-parse', 'HEAD'], repo)).stdout.trim();
  /** @param {string} repo */
  const headShaShort = async (repo) => (await run(['rev-parse', '--short', 'HEAD'], repo)).stdout.trim();
  /** @param {string} repo */
  const currentBranch = async (repo) => (await run(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).stdout.trim();
  /** @param {string} repo */
  const lastCommitSubject = async (repo) => (await run(['log', '-1', '--format=%s'], repo)).stdout.trim() || 'agent update';

  /** @param {string} repo */
  async function hasOrigin(repo) {
    try {
      await run(['remote', 'get-url', 'origin'], repo);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {string[]} args @param {string} repo */
  async function succeeds(args, repo) {
    try {
      await run(args, repo);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The default branch: origin/HEAD, else whichever of main/master exists on origin, else locally.
   * @param {string} repo
   * @returns {Promise<string | null>}
   */
  async function defaultBranch(repo) {
    try {
      const m = (await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).stdout.trim().match(/^origin\/(.+)$/);
      if (m) return m[1];
    } catch {
      /* no origin/HEAD */
    }
    for (const ref of ['refs/remotes/origin/', 'refs/heads/']) {
      for (const b of ['main', 'master']) {
        if (await succeeds(['rev-parse', '--verify', `${ref}${b}`], repo)) return b;
      }
    }
    return null;
  }

  /** @param {string} repo @param {number} issueNumber @returns {Promise<string | null>} */
  async function findLocalIssueBranch(repo, issueNumber) {
    const { stdout } = await run(['branch', '--list', `${settings.issueBranchPrefix}-${issueNumber}-*`, '--format=%(refname:short)'], repo);
    return (
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0] || null
    );
  }

  /**
   * Best-effort: bring a resumed issue branch up to its pushed tip so new commits push as a
   * fast-forward. Never rewrites local work: skipped on a dirty tree, and a diverged branch stays.
   * @param {string} repo @param {string} branch
   */
  async function fastForwardFromOrigin(repo, branch) {
    try {
      if (!(await hasOrigin(repo)) || (await statusPorcelain(repo))) return;
      await run(['fetch', 'origin'], repo);
      await run(['merge', '--ff-only', `origin/${branch}`], repo);
    } catch (e) {
      log('resume: could not fast-forward issue branch from origin (continuing as is)', execErrorText(e));
    }
  }

  /** @param {string} repo */
  async function commitsAheadOfDefault(repo) {
    try {
      const [cur, def] = await Promise.all([currentBranch(repo), defaultBranch(repo)]);
      if (!def || !cur || cur === 'HEAD' || cur === def) return 0;
      return Number.parseInt((await run(['rev-list', '--count', `${def}..HEAD`], repo)).stdout.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  /** `git add -A && git commit -m msg`. @param {string} repo @param {string} msg @returns {Promise<CommitResult>} */
  async function commitAll(repo, msg) {
    try {
      await run(['add', '-A'], repo);
      const { stdout, stderr } = await run(['commit', '-m', msg], repo);
      if ((stdout + stderr).toLowerCase().includes('nothing to commit')) return { ok: false, reason: 'nothing_to_commit', message: msg };
      return { ok: true, sha: await headShaShort(repo), message: msg };
    } catch (e) {
      const out = `${e?.stdout || ''}${e?.stderr || ''}`.toLowerCase();
      if (out.includes('nothing to commit')) return { ok: false, reason: 'nothing_to_commit', message: msg };
      return { ok: false, reason: 'git_error', error: execErrorText(e) };
    }
  }

  /** @param {string} repo @param {boolean} commitOk */
  async function diffText(repo, commitOk) {
    if (commitOk) return (await run(['show', '--no-color', '--pretty=medium', 'HEAD'], repo)).stdout;
    const staged = (await run(['diff', '--no-color', '--cached'], repo)).stdout;
    if (staged.trim()) return staged;
    return (await run(['diff', '--no-color'], repo)).stdout;
  }

  return {
    statusPorcelain,
    headSha,
    headShaShort,
    currentBranch,
    lastCommitSubject,
    hasOrigin,
    defaultBranch,
    commitsAheadOfDefault,

    /**
     * Before an issue run: require a clean tree, fetch, fast-forward the default branch, and create
     * `<prefix>-<n>-<slug>`. If a local branch for this issue already exists (an earlier run that
     * didn't finish), resume on it instead.
     * @param {string} repo
     * @param {number} issueNumber
     * @param {string} [issueTitle]
     * @returns {Promise<{ defaultBranch: string, branchName: string, resumed: boolean }>}
     */
    async prepareForIssue(repo, issueNumber, issueTitle = '') {
      const current = await currentBranch(repo);
      const existing = await findLocalIssueBranch(repo, issueNumber);

      if (existing) {
        if (existing !== current) {
          if (await statusPorcelain(repo)) {
            throw new Error(`Working tree is not clean on \`${current}\`. Commit or stash before switching to the existing issue branch \`${existing}\`.`);
          }
          if (await hasOrigin(repo)) await run(['fetch', 'origin'], repo).catch(() => {});
          await run(['checkout', existing], repo);
        }
        await fastForwardFromOrigin(repo, existing);
        const def = (await defaultBranch(repo)) || 'main';
        log('prepareForIssue: resuming existing branch', { defaultBranch: def, branchName: existing, issueNumber });
        return { defaultBranch: def, branchName: existing, resumed: true };
      }

      if (await statusPorcelain(repo)) {
        throw new Error('Working tree is not clean. Commit or stash your changes before `claude issue:…` so the default branch can be checked out safely.');
      }
      if (!(await hasOrigin(repo))) throw new Error('No git remote named `origin`, so the latest default branch cannot be pulled.');
      await run(['fetch', 'origin'], repo);
      const def = await defaultBranch(repo);
      if (!def) throw new Error('Could not determine the default branch (main/master).');
      await run(['checkout', def], repo);
      await run(['pull', '--ff-only', 'origin', def], repo);

      const base = `${settings.issueBranchPrefix}-${issueNumber}-${slugifyForGitBranch(issueTitle)}`;
      let branchName = base;
      for (let guard = 0; await succeeds(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repo); guard++) {
        if (guard >= 32) throw new Error(`Could not pick a free local branch name starting with "${base}".`);
        branchName = `${base}-${randomBranchSuffix()}`;
      }
      await run(['checkout', '-b', branchName], repo);
      log('prepareForIssue', { defaultBranch: def, branchName, issueNumber });
      return { defaultBranch: def, branchName, resumed: false };
    },

    /**
     * Whether `branch` is this issue's agent branch (`<prefix>-<n>` or `<prefix>-<n>-…`).
     * @param {string} branch @param {number} issueNumber
     */
    isIssueBranch(branch, issueNumber) {
      const p = `${settings.issueBranchPrefix}-${issueNumber}`;
      return branch === p || branch.startsWith(`${p}-`);
    },

    /**
     * If on the default branch or detached, `git checkout -b` so a commit never lands on the default.
     * @param {string} repo
     * @returns {Promise<{ didCheckoutNew: boolean, branchName: string, prBase: string }>}
     */
    async prepareWorkBranch(repo) {
      const def = await defaultBranch(repo);
      const prBase = def || 'main';
      const current = await currentBranch(repo);
      const needNew = current === 'HEAD' || (def ? current === def : /^(main|master)$/i.test(current));
      if (!needNew) return { didCheckoutNew: false, branchName: current, prBase };
      const newBranch = `${settings.workBranchPrefix}-${branchTimestampUtc(new Date(now()))}-${randomBranchSuffix()}`;
      log('creating work branch for the commit', { newBranch, prBase, previous: current });
      await run(['checkout', '-b', newBranch], repo);
      return { didCheckoutNew: true, branchName: newBranch, prBase };
    },

    /**
     * After the issue PR merged, leave the repo on the up-to-date default branch. Never forces: a
     * dirty tree, unknown default or failed checkout leaves it as is (the next prep normalizes it).
     * @param {string} repo
     * @returns {Promise<{ ok: boolean, defaultBranch?: string, reason?: string, error?: string }>}
     */
    async returnToDefaultBranch(repo) {
      try {
        if (await statusPorcelain(repo)) {
          log('return to default branch: skipped, working tree not clean');
          return { ok: false, reason: 'dirty_tree' };
        }
        const origin = await hasOrigin(repo);
        if (origin) await run(['fetch', 'origin'], repo);
        const def = await defaultBranch(repo);
        if (!def) return { ok: false, reason: 'no_default_branch' };
        if ((await currentBranch(repo)) !== def) await run(['checkout', def], repo);
        if (origin) {
          try {
            await run(['pull', '--ff-only', 'origin', def], repo);
          } catch (e) {
            log('return to default branch: fast-forward failed (left as is)', execErrorText(e));
          }
        }
        log('return to default branch', { defaultBranch: def });
        return { ok: true, defaultBranch: def };
      } catch (e) {
        const error = execErrorText(e);
        log('return to default branch: failed', error);
        return { ok: false, reason: 'git_error', error };
      }
    },

    /**
     * Markdown for a resumed run: uncommitted changes and commits already on the branch. Empty on
     * any git error (context only, it never blocks the resume).
     * @param {string} repo @param {string} defaultBranchName
     */
    async resumeContextSummary(repo, defaultBranchName) {
      const lines = [];
      try {
        const status = await statusPorcelain(repo);
        if (status) lines.push('**Uncommitted changes (`git status --porcelain`):**', '```', status, '```');
      } catch {
        /* best-effort */
      }
      try {
        const log = (await run(['log', `${defaultBranchName}..HEAD`, '--oneline'], repo)).stdout.trim();
        if (log) lines.push('', `**Commits already on this branch (not yet on \`${defaultBranchName}\`):**`, '```', log, '```');
      } catch {
        /* best-effort */
      }
      return lines.join('\n').trim();
    },

    /**
     * Wait until the tree is dirty **or** HEAD moved from `preAgentHeadSha` (the agent committed).
     * Agent writes may not be visible to git the instant it exits, hence the short poll.
     * @param {string} repo
     * @param {string | null | undefined} preAgentHeadSha
     * @returns {Promise<GitActivity>}
     */
    async waitForAgentActivity(repo, preAgentHeadSha) {
      const { pollMs, maxWaitMs } = settings.gitWait;
      const pre = typeof preAgentHeadSha === 'string' ? preAgentHeadSha.trim() : '';
      const start = now();
      let polls = 0;
      const probe = async () => {
        const porcelain = await statusPorcelain(repo);
        const headMoved = Boolean(pre) && (await headSha(repo)) !== pre;
        return { dirty: Boolean(porcelain), headMoved, porcelain };
      };
      while (now() - start < maxWaitMs) {
        polls++;
        const p = await probe();
        if (p.dirty || p.headMoved) return { ...p, waitedMs: now() - start, polls };
        await sleep(pollMs);
      }
      const p = await probe();
      log(`no agent git activity after ${maxWaitMs}ms / ${polls} polls`, { dirty: p.dirty, headMoved: p.headMoved });
      return { ...p, waitedMs: now() - start, polls };
    },

    /** Commit everything with a conventional subject derived from the prompt. @param {string} repo @param {string} userPrompt */
    async commitWork(repo, userPrompt) {
      try {
        await run(['add', '-A'], repo);
      } catch (e) {
        return { ok: false, reason: 'git_error', error: execErrorText(e) };
      }
      const nameOnly = (await run(['diff', '--cached', '--name-only', 'HEAD'], repo).catch(() => ({ stdout: '' }))).stdout;
      return commitAll(repo, buildCommitMessage(nameOnly, userPrompt));
    },

    /**
     * WIP snapshot of leftover work from a run that didn't finish, so the tree is clean and a
     * re-run resumes on the branch instead of refusing a dirty tree.
     * @param {string} repo @param {number} issueNumber
     * @returns {Promise<CommitResult>}
     */
    commitWip: (repo, issueNumber) => commitAll(repo, wipCommitMessage(issueNumber)),

    /** @param {string} repo @returns {Promise<{ ok: boolean, error?: string }>} */
    async pushHead(repo) {
      try {
        await run(['push', '-u', 'origin', 'HEAD'], repo);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: execErrorText(e) };
      }
    },

    /**
     * Diff for the LLM review. When the agent committed (clean tree, HEAD moved), `git show HEAD`
     * would only cover the tip, so prefer `<prBase>...HEAD`, then `<pre>...HEAD`.
     * @param {string} repo
     * @param {{ prBase: string, branchName?: string }} workBranch
     * @param {{ dirty: boolean, headMoved: boolean }} wait
     * @param {string | null | undefined} preAgentHeadSha
     * @param {boolean} commitOk
     * @returns {Promise<string>}
     */
    async reviewDiffText(repo, workBranch, wait, preAgentHeadSha, commitOk) {
      if (wait.dirty || !wait.headMoved) return diffText(repo, commitOk);
      const ranges = [`${String(workBranch?.prBase || 'main').trim() || 'main'}...HEAD`];
      if (typeof preAgentHeadSha === 'string' && preAgentHeadSha.trim()) ranges.push(`${preAgentHeadSha.trim()}...HEAD`);
      for (const range of ranges) {
        try {
          const { stdout } = await run(['diff', '--no-color', range], repo);
          if (stdout.trim()) return stdout;
        } catch {
          /* unknown ref, try the next */
        }
      }
      try {
        return (await run(['show', '--no-color', '--pretty=medium', 'HEAD'], repo)).stdout;
      } catch {
        return '';
      }
    },
  };
}
