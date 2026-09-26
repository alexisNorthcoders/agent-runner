import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { execErrorText } from './exec.js';
import { pollGithubIssueClosedOrTimeout } from './issueClosePoll.js';

/**
 * `gh` calls for the PR half of post-run: open or find the PR, comment the review, wait for
 * mergeability, merge (auto or direct, with the repo's allowed method), and poll the issue closed.
 */

/** GitHub caps comments below 64 KiB; stay under with margin. */
const GITHUB_PR_COMMENT_MAX_CHARS = 62_000;
const PULL_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;

/**
 * GitHub rejected a merge because the head/base raced ("head branch is out of date", "Base branch
 * was modified", …).
 * @param {string} combinedMessage
 */
export function githubPrMergeErrorLooksStaleHead(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  return (
    m.includes('out of date') || m.includes('head branch is behind') || m.includes('head branch must be') || m.includes('base branch was modified')
  );
}

/** "Pull Request is not mergeable", common right after a push while GitHub recomputes. @param {string} combinedMessage */
export function githubPrMergeErrorLooksNotYetMergeable(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  return m.includes('not mergeable') || m.includes('isnt mergeable') || m.includes("isn't mergeable");
}

/**
 * The call failed on the network rather than on GitHub's answer (e.g. `dial tcp …: i/o timeout`
 * from a flaky Pi connection), so the same call can simply be retried.
 * @param {string} combinedMessage
 */
export function githubErrorLooksTransientNetwork(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  if (!m) return false;
  return [
    'i/o timeout',
    'etimedout',
    'econnreset',
    'econnrefused',
    'eai_again',
    'tls handshake timeout',
    'connection reset by peer',
    'could not resolve host',
    'network is unreachable',
    '502 bad gateway',
    '503 service unavailable',
    '504 gateway timeout',
  ].some((needle) => m.includes(needle));
}

/**
 * `gh pr view --json mergeable,mergeStateStatus,state` → merge readiness.
 * @param {{ mergeable?: string, mergeStateStatus?: string, state?: string } | null | undefined} view
 * @returns {'ready' | 'waiting' | 'behind' | 'conflict' | 'blocked' | 'draft' | 'closed'}
 */
export function classifyGithubPrMergeability(view) {
  const state = String(view?.state || '').toUpperCase();
  if (state === 'MERGED' || state === 'CLOSED') return 'closed';
  const mergeable = String(view?.mergeable || '').toUpperCase();
  const status = String(view?.mergeStateStatus || '').toUpperCase();
  if (status === 'DRAFT') return 'draft';
  if (mergeable === 'CONFLICTING' || status === 'DIRTY') return 'conflict';
  if (status === 'BEHIND') return 'behind';
  if (status === 'BLOCKED') return 'blocked';
  if (mergeable === 'MERGEABLE' && status !== 'UNKNOWN') return 'ready';
  return 'waiting';
}

/**
 * `gh pr merge --auto` failed because there is nothing to wait on (no branch protection), so a
 * direct merge is correct.
 * @param {string} combinedMessage
 */
export function githubPrMergeErrorLooksNoAutoMergeGate(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  return m.includes('protected branch rules not configured') || m.includes('pull request is in clean status');
}

/** update-branch returns 422 when the branch is already up to date. @param {string} combinedMessage */
export function githubPrUpdateBranchErrorLooksNoOp(combinedMessage) {
  const m = String(combinedMessage || '').toLowerCase();
  return m.includes('no new commits on the base branch') || m.includes('already up to date');
}

/**
 * Merge method from the repo's settings: squash, then merge commit, then rebase.
 * @param {{ allow_squash_merge?: boolean, allow_merge_commit?: boolean, allow_rebase_merge?: boolean }} caps
 * @returns {'squash' | 'merge' | 'rebase' | null}
 */
export function pickGithubMergeStrategy(caps) {
  const c = caps || {};
  if (c.allow_squash_merge) return 'squash';
  if (c.allow_merge_commit) return 'merge';
  if (c.allow_rebase_merge) return 'rebase';
  return null;
}

/** @param {'squash' | 'merge' | 'rebase'} strategy */
export function githubMergeMethodSummaryLabel(strategy) {
  return strategy === 'merge' ? 'merge commit' : strategy === 'squash' || strategy === 'rebase' ? strategy : 'merge';
}

/** @param {string} prUrl @returns {{ owner: string, repo: string, number: number } | null} */
function parsePullUrl(prUrl) {
  const m = String(prUrl || '').trim().match(PULL_URL_RE);
  const n = m ? parseInt(m[3], 10) : NaN;
  return m && n > 0 ? { owner: m[1], repo: m[2], number: n } : null;
}

const isPullUrl = (u) => PULL_URL_RE.test(String(u || '').trim());

/**
 * @typedef {{
 *   ok: boolean,
 *   error?: string,
 *   transientNetwork?: boolean,
 *   staleHeadSynced?: boolean,
 *   mergedDirectly?: boolean,
 *   mergeMethod?: 'squash' | 'merge' | 'rebase',
 * }} MergeResult
 *   `transientNetwork` (set on every failure) says the merge failed only because GitHub could not be
 *   reached, so running it again later may well succeed; false means a real blocker.
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
export function createGithubPr({ exec, settings, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  /** @param {string} repo @param {string[]} args */
  const gh = (repo, args) => exec('gh', args, { cwd: repo, maxBuffer: 10 * 1024 * 1024 });

  /** First open PR URL for `head` (any base), or null. @param {string} repo @param {string} head */
  async function firstOpenPrUrlForHead(repo, head) {
    try {
      const { stdout } = await gh(repo, ['pr', 'list', '--head', head, '--state', 'open', '--json', 'url', '--limit', '5']);
      const arr = JSON.parse(stdout || '[]');
      const url = Array.isArray(arr) && arr[0]?.url ? String(arr[0].url).trim() : '';
      return isPullUrl(url) ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} repo @param {string} prUrl
   * @returns {Promise<{ ok: boolean, mergeable?: string, mergeStateStatus?: string, state?: string, error?: string }>}
   */
  async function viewMergeability(repo, prUrl) {
    if (!isPullUrl(prUrl)) return { ok: false, error: 'Invalid PR URL for mergeability poll' };
    try {
      const { stdout } = await gh(repo, ['pr', 'view', String(prUrl).trim(), '--json', 'mergeable,mergeStateStatus,state']);
      const j = JSON.parse(String(stdout || '{}'));
      return { ok: true, mergeable: String(j.mergeable || ''), mergeStateStatus: String(j.mergeStateStatus || ''), state: String(j.state || '') };
    } catch (e) {
      return { ok: false, error: execErrorText(e) };
    }
  }

  /**
   * Merge the base into the PR head via the REST API (the UI's "Update branch"; old Debian `gh`
   * lacks `gh pr update-branch`).
   * @param {string} repo @param {string} prUrl
   * @returns {Promise<{ ok: boolean, error?: string, noOp?: boolean }>}
   */
  async function updateBranch(repo, prUrl) {
    const p = parsePullUrl(prUrl);
    if (!p) return { ok: false, error: 'Invalid PR URL for GitHub update-branch API' };
    try {
      await gh(repo, ['api', '-X', 'PUT', `repos/${p.owner}/${p.repo}/pulls/${p.number}/update-branch`]);
      return { ok: true };
    } catch (e) {
      const err = execErrorText(e);
      return githubPrUpdateBranchErrorLooksNoOp(err) ? { ok: true, noOp: true } : { ok: false, error: err };
    }
  }

  /**
   * Poll until the PR is ready for a direct merge, permanently blocked, or the wait runs out. A PR
   * that is behind its base gets update-branch (when enabled) and keeps polling.
   * @param {string} repo @param {string} prUrl
   */
  async function waitForMergeable(repo, prUrl) {
    const { pollMs, maxWaitMs } = settings.mergeableWait;
    const start = now();
    let polls = 0;
    let staleHeadSynced = false;
    /** @type {string | undefined} */
    let classification;
    let lastViewError = '';
    while (now() - start < maxWaitMs) {
      polls++;
      const view = await viewMergeability(repo, prUrl);
      if (!view.ok) {
        lastViewError = view.error || '';
        log('waitForMergeable: pr view failed', view.error);
        await sleep(pollMs);
        continue;
      }
      lastViewError = '';
      classification = classifyGithubPrMergeability(view);
      log(`waitForMergeable poll #${polls}`, { classification, mergeable: view.mergeable, mergeStateStatus: view.mergeStateStatus, state: view.state });
      if (classification === 'ready' || classification === 'closed') {
        return { ok: true, waitedMs: now() - start, polls, classification, staleHeadSynced };
      }
      if (classification === 'conflict' || classification === 'draft') {
        return {
          ok: false,
          error: `PR is not mergeable (${classification}; mergeable=${view.mergeable || '?'} status=${view.mergeStateStatus || '?'}).`,
          waitedMs: now() - start,
          polls,
          classification,
          staleHeadSynced,
        };
      }
      if (classification === 'behind' && settings.staleHeadSync) {
        const sync = await updateBranch(repo, prUrl);
        if (sync.ok && !sync.noOp) staleHeadSynced = true;
        if (!sync.ok) log('waitForMergeable: update-branch failed', sync.error);
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      error: `Timed out after ${maxWaitMs}ms waiting for PR mergeability (last=${classification || 'unknown'}; polls=${polls}).`,
      // never got an answer from GitHub, only network errors
      transientNetwork: !classification && githubErrorLooksTransientNetwork(lastViewError),
      waitedMs: now() - start,
      polls,
      classification,
      staleHeadSynced,
    };
  }

  /**
   * Merge settings of the PR's repo (REST GET /repos/{owner}/{repo}). A network error gets one
   * wait and retry, like the direct merge.
   * @param {string} repo git cwd for `gh`
   * @param {string} owner
   * @param {string} repoSlug
   * @returns {Promise<{ ok: boolean, allow_squash_merge?: boolean, allow_merge_commit?: boolean, allow_rebase_merge?: boolean, allow_auto_merge?: boolean, error?: string }>}
   */
  async function repoMergeCapabilities(repo, owner, repoSlug) {
    const read = () => gh(repo, ['api', `repos/${owner}/${repoSlug}`, '--jq', '{allow_squash_merge,allow_merge_commit,allow_rebase_merge,allow_auto_merge}']);
    let raw;
    try {
      ({ stdout: raw } = await read());
    } catch (e) {
      const err = execErrorText(e);
      if (!githubErrorLooksTransientNetwork(err)) return { ok: false, error: err };
      log('repoMergeCapabilities: network error; wait then retry', err);
      await sleep(settings.mergeableWait.pollMs);
      try {
        ({ stdout: raw } = await read());
      } catch (eRetry) {
        return { ok: false, error: `${execErrorText(eRetry)} (retried once after a network error)` };
      }
    }
    raw = String(raw ?? '').trim();
    let j;
    try {
      j = JSON.parse(raw);
    } catch (err) {
      const bit = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw || '(empty stdout)';
      return { ok: false, error: `Could not parse gh api --jq JSON for merge settings: ${err.message || err}. Output: ${bit}` };
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: 'gh api --jq returned a non-object for merge settings.' };
    for (const k of ['allow_squash_merge', 'allow_merge_commit', 'allow_rebase_merge', 'allow_auto_merge']) {
      if (!Object.prototype.hasOwnProperty.call(j, k)) {
        return { ok: false, error: `GitHub repo API jq output missing "${k}"; cannot read merge settings reliably.` };
      }
    }
    if (typeof j.allow_auto_merge !== 'boolean') {
      return {
        ok: false,
        error: `GitHub repo API returned non-boolean allow_auto_merge (${JSON.stringify(j.allow_auto_merge)}). Refusing to guess; check gh/API version and repo access.`,
      };
    }
    return {
      ok: true,
      allow_squash_merge: Boolean(j.allow_squash_merge),
      allow_merge_commit: Boolean(j.allow_merge_commit),
      allow_rebase_merge: Boolean(j.allow_rebase_merge),
      allow_auto_merge: j.allow_auto_merge,
    };
  }

  /**
   * Merge the PR with a method the repo allows (squash preferred). Queues `gh pr merge --auto`,
   * falling back to a direct merge when there is nothing for auto-merge to wait on (unprotected
   * branch) or the repo disallows auto-merge (private Free-plan repos). A stale head gets one
   * update-branch and a retry. Direct merges first wait for GitHub to report the PR mergeable, and
   * retry once on a network error, a stale base or a mergeability race.
   * @param {string} repo
   * @param {string} prUrl
   * @returns {Promise<MergeResult>}
   */
  async function queueAutoMerge(repo, prUrl) {
    const url = String(prUrl || '').trim();
    const parsed = parsePullUrl(url);
    if (!parsed) return { ok: false, error: 'Invalid PR URL for gh pr merge', transientNetwork: false };

    const caps = await repoMergeCapabilities(repo, parsed.owner, parsed.repo);
    if (!caps.ok) {
      return {
        ok: false,
        error: `Could not read repository merge settings (GitHub API): ${caps.error}. Fix \`gh auth\` or network, then retry.`,
        transientNetwork: githubErrorLooksTransientNetwork(caps.error || ''),
      };
    }
    const strategy = pickGithubMergeStrategy(caps);
    if (!strategy) {
      return {
        ok: false,
        transientNetwork: false,
        error: 'No merge method is allowed on this repository (squash, merge commit, and rebase are all disabled). Enable at least one under **Settings → General → Pull requests**.',
      };
    }
    const flag = `--${strategy}`;
    const mergeAuto = () => gh(repo, ['pr', 'merge', url, '--auto', flag]);
    const mergeDirect = () => gh(repo, ['pr', 'merge', url, flag]);
    /**
     * @param {string} error the whole story, for the report
     * @param {boolean} transientNetwork whether the error that decided the failure was a network error
     * @param {{ staleHeadSynced?: boolean }} [extra]
     * @returns {MergeResult}
     */
    const fail = (error, transientNetwork, extra = {}) => ({
      ok: false,
      error,
      transientNetwork,
      mergeMethod: strategy,
      ...extra,
    });

    /** @param {string} errFromAuto @param {{ staleHeadSynced?: boolean }} [extra] @returns {Promise<MergeResult>} */
    async function directMergeFallback(errFromAuto, extra = {}) {
      log('queueAutoMerge: no auto-merge gate; falling back to a direct merge', url);
      const why = String(errFromAuto || '').trim();
      const ready = await waitForMergeable(repo, url);
      const synced = { staleHeadSynced: Boolean(extra.staleHeadSynced || ready.staleHeadSynced) };
      if (!ready.ok) return fail(`${why}\n\nDirect merge fallback aborted: ${ready.error || 'PR not mergeable yet'}`, Boolean(ready.transientNetwork), synced);
      try {
        await mergeDirect();
        return { ok: true, mergedDirectly: true, mergeMethod: strategy, ...synced };
      } catch (eDirect) {
        const errDirect = String(execErrorText(eDirect)).trim();
        const transient = githubErrorLooksTransientNetwork(errDirect);
        const stale = githubPrMergeErrorLooksStaleHead(errDirect);
        if (!transient && !(settings.staleHeadSync && (stale || githubPrMergeErrorLooksNotYetMergeable(errDirect)))) {
          return fail(`${why}\n\nDirect merge fallback failed: ${errDirect}`, false, synced);
        }
        log(
          transient
            ? 'queueAutoMerge: direct merge hit a network error; wait then retry'
            : stale
              ? 'queueAutoMerge: direct merge hit a stale base; update-branch then retry'
              : 'queueAutoMerge: direct merge hit not-yet-mergeable; wait then retry',
          url
        );
        if (!transient && stale) {
          const sync = await updateBranch(repo, url);
          if (!sync.ok) {
            return fail(`${why}\n\nDirect merge fallback failed: ${errDirect}\n\nGitHub update-branch failed: ${sync.error || 'unknown'}`, githubErrorLooksTransientNetwork(sync.error || ''), synced);
          }
          synced.staleHeadSynced = !sync.noOp || synced.staleHeadSynced;
        }
        const readyAgain = await waitForMergeable(repo, url);
        synced.staleHeadSynced = synced.staleHeadSynced || Boolean(readyAgain.staleHeadSynced);
        if (!readyAgain.ok) {
          return fail(`${why}\n\nDirect merge fallback failed: ${errDirect}\n\nRetry wait: ${readyAgain.error || 'PR not mergeable'}`, Boolean(readyAgain.transientNetwork), synced);
        }
        if (readyAgain.classification === 'closed') {
          // a merge request that timed out on our side may still have landed on GitHub
          const view = await viewMergeability(repo, url);
          if (view.ok && String(view.state).toUpperCase() === 'MERGED') return { ok: true, mergedDirectly: true, mergeMethod: strategy, ...synced };
        }
        try {
          await mergeDirect();
          return { ok: true, mergedDirectly: true, mergeMethod: strategy, ...synced };
        } catch (eRetry) {
          const errRetry = String(execErrorText(eRetry)).trim();
          return fail(`${why}\n\nDirect merge fallback failed: ${errDirect}\n\nAfter wait/retry: ${errRetry}`, githubErrorLooksTransientNetwork(errRetry), synced);
        }
      }
    }

    if (caps.allow_auto_merge === false) {
      return directMergeFallback('GitHub **Allow auto-merge** is disabled for this repository (common on private Free-plan repos).');
    }
    try {
      await mergeAuto();
      return { ok: true, mergeMethod: strategy };
    } catch (e) {
      const errFirst = String(execErrorText(e)).trim();
      if (githubPrMergeErrorLooksNoAutoMergeGate(errFirst)) return directMergeFallback(errFirst);
      if (!settings.staleHeadSync || !githubPrMergeErrorLooksStaleHead(errFirst)) return fail(errFirst, githubErrorLooksTransientNetwork(errFirst));
      log('queueAutoMerge: stale head blocked auto-merge; update-branch then retry', url);
      const sync = await updateBranch(repo, url);
      if (!sync.ok) return fail(`${errFirst}\n\nGitHub update-branch failed: ${sync.error || 'unknown'}`, githubErrorLooksTransientNetwork(sync.error || ''));
      try {
        await mergeAuto();
        return { ok: true, staleHeadSynced: !sync.noOp, mergeMethod: strategy };
      } catch (e2) {
        const errSecond = String(execErrorText(e2)).trim();
        if (githubPrMergeErrorLooksNoAutoMergeGate(errSecond)) return directMergeFallback(errSecond, { staleHeadSynced: !sync.noOp });
        return fail(`${errFirst}\n\nAfter update-branch: ${errSecond}`, githubErrorLooksTransientNetwork(errSecond));
      }
    }
  }

  /** @param {string} repo @param {number} issueNumber @param {string} fields */
  async function viewIssue(repo, issueNumber, fields) {
    const { stdout } = await exec('gh', ['issue', 'view', String(issueNumber), '--json', fields], { cwd: repo, maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout || '{}');
  }

  return {
    firstOpenPrUrlForHead,
    viewMergeability,
    waitForMergeable,
    repoMergeCapabilities,
    queueAutoMerge,

    /**
     * The open PR for `branchName` with its merge readiness, or null (none, or the lookup failed).
     * @param {string} repo @param {string} branchName
     * @returns {Promise<{ url: string, branchName: string, state: string } | null>}
     */
    async findOpenPrForBranch(repo, branchName) {
      if (!branchName || branchName === 'HEAD') return null;
      const url = await firstOpenPrUrlForHead(repo, branchName);
      if (!url) return null;
      const view = await viewMergeability(repo, url);
      return { url, branchName, state: view.ok ? classifyGithubPrMergeability(view) : 'waiting' };
    },

    /**
     * Open PR from `head` into `base`: `{ ok: true, url }`, `{ ok: true }` for none, or an error.
     * @param {string} repo @param {{ head: string, base: string }} p
     * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
     */
    async listOpenPrForHead(repo, { head, base }) {
      try {
        const { stdout } = await gh(repo, ['pr', 'list', '--head', head, '--base', base, '--state', 'open', '--json', 'url', '--limit', '5']);
        const arr = JSON.parse(stdout || '[]');
        const url = Array.isArray(arr) && arr[0]?.url ? String(arr[0].url).trim() : '';
        return isPullUrl(url) ? { ok: true, url } : { ok: true };
      } catch (e) {
        return { ok: false, error: execErrorText(e) };
      }
    },

    /**
     * @param {string} repo @param {{ base: string, title: string, body: string }} p
     * @returns {Promise<{ ok: boolean, url?: string, error?: string }>}
     */
    async createPr(repo, { base, title, body }) {
      try {
        const { stdout, stderr } = await gh(repo, ['pr', 'create', '--base', base, '--title', title, '--body', body]);
        const url = `${stdout || ''}\n${stderr || ''}`
          .split('\n')
          .map((l) => l.trim())
          .find((l) => isPullUrl(l));
        return url ? { ok: true, url } : { ok: false, error: 'gh pr create did not return a PR URL' };
      } catch (e) {
        return { ok: false, error: execErrorText(e) };
      }
    },

    /**
     * One top-level PR comment (not an inline review), via a temp file to dodge argv limits.
     * @param {string} repo @param {string} prUrl @param {string} body
     * @returns {Promise<{ ok: boolean, error?: string }>}
     */
    async comment(repo, prUrl, body) {
      if (!isPullUrl(prUrl)) return { ok: false, error: 'Invalid PR URL for gh pr comment' };
      let text = String(body || '');
      if (text.length > GITHUB_PR_COMMENT_MAX_CHARS) {
        text = `${text.slice(0, GITHUB_PR_COMMENT_MAX_CHARS - 120)}\n\n[… comment truncated for GitHub length limit …]`;
      }
      const path = join(tmpdir(), `agent-runner-pr-comment-${process.pid}-${now()}-${Math.random().toString(16).slice(2)}.md`);
      try {
        await writeFile(path, text, 'utf8');
        await gh(repo, ['pr', 'comment', String(prUrl).trim(), '--body-file', path]);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: execErrorText(e) };
      } finally {
        await unlink(path).catch(() => {});
      }
    },

    /**
     * @param {string} repo @param {number} issueNumber
     * @returns {Promise<{ ok: boolean, title?: string, body?: string, state?: string, url?: string, error?: string }>}
     */
    async issueDetails(repo, issueNumber) {
      try {
        const j = await viewIssue(repo, issueNumber, 'title,body,state,url');
        return {
          ok: true,
          title: String(j.title || '').trim(),
          body: String(j.body || '').trim(),
          state: String(j.state || '').trim().toUpperCase(),
          url: String(j.url || '').trim(),
        };
      } catch (e) {
        return { ok: false, error: execErrorText(e) };
      }
    },

    /**
     * Poll until the issue is CLOSED (the merged PR's `Fixes #n` closed it) or the wait runs out.
     * @param {string} repo @param {number} issueNumber
     */
    waitForIssueClosed(repo, issueNumber) {
      return pollGithubIssueClosedOrTimeout({
        ...settings.issueCloseWait,
        sleep,
        now,
        fetchState: async () => {
          try {
            return { ok: true, state: String((await viewIssue(repo, issueNumber, 'state')).state || '').trim().toUpperCase() };
          } catch (e) {
            return { ok: false, error: execErrorText(e) };
          }
        },
        onPollError: (d) => log(`issue #${issueNumber} poll failed`, d.error),
      });
    },
  };
}
