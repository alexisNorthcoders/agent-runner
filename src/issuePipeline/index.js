import { appendFile } from 'fs/promises';
import { createExec } from './exec.js';
import { createGithubIssues } from './githubIssue.js';
import { createGitWorkspace } from './gitWorkspace.js';
import { createGithubPr } from './githubPr.js';
import { createLlm } from './llm.js';
import { createGmailSender } from './mailer.js';
import { createPostRun } from './postRun.js';

/**
 * The GitHub issue pipeline behind `claude issue:<alias>:<n>` and the cron tracer: the two
 * share `prepare` (fetch the issue, branch in place, build the prompt, with resume context) and
 * `finish` (post-run, then one short outbox message). The runner owns the lock and the agent
 * process in between.
 *
 * @typedef {{ number: number, repo: string, title: string }} IssueRef
 * @typedef {'merged' | 'pr_open' | 'pushed' | 'no_changes' | 'timeout' | 'failed'} IssueRunResult
 * @typedef {Pick<import('../agentBackend/index.js').AgentResult, 'outcome' | 'exitCode' | 'stderr'>} AgentOutcomeLike
 */

/** @param {unknown} err */
export function errorMessageFromUnknown(err) {
  if (err instanceof Error) return err.message?.trim() ? err.message : err.name || 'Error';
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.trim()) return err.message;
  try {
    return String(err);
  } catch {
    return 'Unknown error';
  }
}

/** One-line reason the agent itself didn't succeed. @param {AgentOutcomeLike | undefined} r */
function agentFailureReason(r) {
  switch (r?.outcome) {
    case 'spawn_error':
      return `could not start (${String(r.stderr || '').trim().slice(0, 200)})`;
    case 'timeout':
      return 'timed out';
    case 'stopped':
      return 'was stopped by claude:stop';
    default:
      return `exited with code ${r?.exitCode ?? 'n/a'}`;
  }
}

/**
 * Short message for a finished issue run: one `✅` line on success, a short `⚠️` naming the
 * problem, or null when there is nothing to report (post-run off, or the agent changed nothing).
 * The full narrative (`post.note`) goes to the run log instead.
 * @param {{
 *   issue: { number: number, title?: string },
 *   agentOk: boolean,
 *   agent?: AgentOutcomeLike,
 *   post: import('./postRun.js').PostRunResult | null,
 *   postErrMessage?: string,
 * }} p
 * @returns {string | null}
 */
export function buildIssueRunMessage({ issue, agentOk, agent, post, postErrMessage = '' }) {
  const label = `#${issue.number}${issue.title ? ` — ${issue.title}` : ''}`;
  const attention = (problem) => `⚠️ ${label}: ${problem} — needs a look.`;

  if (!agentOk) {
    const wip = post?.wip?.ok ? ` Its leftover work is committed as WIP \`${post.wip.sha}\`; run the issue again to resume.` : '';
    return `${attention(`agent ${agentFailureReason(agent)}`)}${wip}`;
  }
  if (postErrMessage) return attention(`post-run pipeline failed (${postErrMessage})`);
  if (!post) return null;
  switch (post.skipReason) {
    case 'branch_prep_failed':
      return attention('could not prepare a feature branch');
    case 'empty_diff':
      return attention('changes detected but no diff could be read for review');
    case 'post_run_threw':
      return attention('post-run pipeline failed');
  }
  if (!post.commit) return null;
  if (!post.commit.ok) return attention(`auto-commit failed (${post.commit.reason ?? 'unknown'})`);
  if (post.pushResult && !post.pushResult.ok) return attention(`push failed (${post.pushResult.error ?? 'unknown error'})`);
  if (post.prResult && !post.prResult.ok) return attention(`PR creation failed (${post.prResult.error ?? 'unknown error'})`);
  if (post.postReviewAutofix?.mergeBlocked) return attention('merge blocked by the autofix pass');
  if (post.postCloseChangesEmail && !post.postCloseChangesEmail.ok) {
    return attention(`post-close summary email failed (${post.postCloseChangesEmail.step ?? 'unknown step'})`);
  }
  if (post.prAutoMergeResult && !post.prAutoMergeResult.ok) return attention(`auto-merge was not enabled (${post.prAutoMergeResult.error ?? 'unknown error'})`);

  const url = post.prResult?.url ? ` ${post.prResult.url}` : '';
  const title = issue.title ? ` — ${issue.title}` : '';
  const merge = post.prAutoMergeResult;
  if (merge?.ok && (merge.mergedDirectly || post.issueCloseWait?.closed)) return `✅ #${issue.number} merged${title}`;
  if (merge?.ok) return `✅ #${issue.number} merge queued${title}${url}`;
  if (post.prResult?.ok) return `✅ #${issue.number} PR open${title}${url}`;
  return `✅ #${issue.number} pushed${title}`;
}

/**
 * Final result of an issue run, for history and the cron's "did this count as progress".
 * @param {{ agentOk: boolean, agent?: AgentOutcomeLike, post: import('./postRun.js').PostRunResult | null, postErrMessage?: string }} p
 * @returns {IssueRunResult}
 */
export function classifyIssueRunResult({ agentOk, agent, post, postErrMessage = '' }) {
  if (agent?.outcome === 'timeout') return 'timeout';
  if (!agentOk || postErrMessage || !post) return 'failed';
  if (['branch_prep_failed', 'empty_diff', 'post_run_threw'].includes(post.skipReason ?? '')) return 'failed';
  if (!post.commit) return 'no_changes';
  if (!post.commit.ok || (post.pushResult && !post.pushResult.ok) || (post.prResult && !post.prResult.ok)) return 'failed';
  const merge = post.prAutoMergeResult;
  if (merge?.ok && (merge.mergedDirectly || post.issueCloseWait?.closed)) return 'merged';
  if (merge?.ok || post.prResult?.ok) return 'pr_open';
  return 'pushed';
}

/**
 * Resume-prompt section for a branch whose PR is open but never merged. A conflict is resolved by
 * merging (not rebasing) the default branch in, so the fix pushes as a fast-forward.
 * @param {{ url: string, state: string }} pr
 * @param {string} defaultBranch
 */
export function buildOpenPrResumeNote(pr, defaultBranch) {
  const lines = [
    '## Open pull request',
    '',
    `This branch already has an open PR that was not merged: ${pr.url}. Read its review comments (\`gh pr view --comments\`) and address any that are valid.`,
  ];
  if (pr.state === 'conflict') {
    lines.push(
      '',
      `**The PR conflicts with \`${defaultBranch}\`.** Run \`git fetch origin\` and \`git merge origin/${defaultBranch}\`, resolve the conflicts keeping the behaviour of both sides, run the tests, and commit the merge. Do not rebase or force-push.`
    );
  }
  return lines.join('\n');
}

/**
 * @param {{ branchName: string, resumeNote: string, openPrNote: string }} p
 */
function resumeSection({ branchName, resumeNote, openPrNote }) {
  return [
    '## Resuming an interrupted run',
    '',
    `You are continuing on the existing branch \`${branchName}\` from a previous run on this same issue that did not finish (it timed out, errored, or agent-runner restarted before it completed). Do not start over — inspect what is already there (git log, git status, and the files already changed) and continue or finish the remaining tasks.`,
    resumeNote ? `\n${resumeNote}` : '',
    openPrNote ? `\n${openPrNote}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {{
 *   settings: import('./settings.js').PipelineSettings,
 *   exec?: import('./exec.js').Exec,
 *   fetchFn?: import('./llm.js').FetchLike,
 *   sendMail?: import('./mailer.js').SendMail,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   logger?: Pick<Console, 'log'>,
 * }} deps
 */
export function createIssuePipeline({ settings, exec, fetchFn, sendMail, sleep, now, logger = console }) {
  const ex = exec ?? createExec({ timeoutMs: settings.execTimeoutMs, ghBin: settings.ghBin });
  /** @param {string} message @param {unknown} [detail] */
  const log = (message, detail) => {
    if (!settings.log) return;
    if (detail === undefined || detail === '') logger.log('[issuePipeline]', message);
    else logger.log('[issuePipeline]', message, typeof detail === 'string' ? detail : JSON.stringify(detail));
  };
  const git = createGitWorkspace({ exec: ex, settings, log, sleep, now });
  const prs = createGithubPr({ exec: ex, settings, log, sleep, now });
  const issues = createGithubIssues({ exec: ex, settings, sleep });
  const postRun = createPostRun({
    git,
    prs,
    llm: createLlm({ settings, fetchFn, log }),
    sendMail: sendMail ?? createGmailSender(settings.email),
    settings,
    log,
  });

  return {
    git,
    prs,
    postRun,
    /** Issue lookups, including the cron's repo-wide ones. */
    github: issues,

    /**
     * Fetch the issue and branch in place in `workspaceRoot` (resuming an unfinished branch), and
     * build the agent prompt. Throws an Error whose message is fit to send to the user.
     * @param {{ issueNumber: number, alias: string | null, workspaceRoot: string, extraInstructions?: string }} p
     * @returns {Promise<{ prompt: string, issue: IssueRef, branchName: string, defaultBranch: string, resumed: boolean, preAgentHeadSha: string | null }>}
     */
    async prepare({ issueNumber, alias, workspaceRoot, extraInstructions = '' }) {
      let fetched;
      try {
        fetched = await issues.fetchIssuePrompt({ issueNumber, workspaceRoot, alias, extraInstructions });
      } catch (err) {
        throw new Error(`Failed to read GitHub issue #${issueNumber}: ${errorMessageFromUnknown(err)}`);
      }
      const issue = { number: fetched.number, repo: fetched.repo, title: fetched.title };
      try {
        const prep = await git.prepareForIssue(workspaceRoot, issueNumber, issue.title);
        let prompt = fetched.markdown;
        if (prep.resumed) {
          const pr = await prs.findOpenPrForBranch(workspaceRoot, prep.branchName);
          prompt = `${prompt}\n\n${resumeSection({
            branchName: prep.branchName,
            resumeNote: await git.resumeContextSummary(workspaceRoot, prep.defaultBranch),
            openPrNote: pr ? buildOpenPrResumeNote(pr, prep.defaultBranch) : '',
          })}`;
        }
        const preAgentHeadSha = await git.headSha(workspaceRoot).catch(() => null);
        return { prompt, issue, branchName: prep.branchName, defaultBranch: prep.defaultBranch, resumed: prep.resumed, preAgentHeadSha };
      } catch (err) {
        throw new Error(`Git setup for issue #${issueNumber} failed: ${errorMessageFromUnknown(err)}`);
      }
    },

    /**
     * After the agent exits: post-run, then the one message to send. The long narrative is
     * appended to the run log. Never throws.
     * @param {{
     *   repo: string,
     *   prompt: string,
     *   issue: IssueRef,
     *   agent: AgentOutcomeLike,
     *   preAgentHeadSha: string | null,
     *   logPath: string,
     *   runAgent: import('./postRun.js').RunAgent,
     * }} p
     * @returns {Promise<{ result: IssueRunResult, message: string, silent: boolean, post: import('./postRun.js').PostRunResult }>}
     *   `silent` marks a run with nothing to report (the agent changed nothing), which cron can skip.
     */
    async finish({ repo, prompt, issue, agent, preAgentHeadSha, logPath, runAgent }) {
      const agentOk = agent.outcome === 'success';
      /** @type {import('./postRun.js').PostRunResult} */
      let post;
      let postErrMessage = '';
      try {
        post = await postRun.runPostRun({ repo, userPrompt: prompt, agentOk, issueNumber: issue.number, preAgentHeadSha, runAgent });
      } catch (err) {
        postErrMessage = errorMessageFromUnknown(err);
        post = { ran: false, note: '', skipReason: 'post_run_threw' };
        log('post-run threw', err?.stack || postErrMessage);
      }
      const result = classifyIssueRunResult({ agentOk, agent, post, postErrMessage });
      const report = [post.note, postErrMessage && `Post-run pipeline failed: ${postErrMessage}`].filter(Boolean).join('\n\n');
      if (report) await appendFile(logPath, `\n\n--- post-run report ---\n${report}\n`).catch(() => {});

      let message = buildIssueRunMessage({ issue, agentOk, agent, post, postErrMessage });
      const silent = message == null;
      if (silent) {
        message =
          post.skipReason === 'disabled'
            ? `ℹ️ #${issue.number}: the agent finished; post-run is off (CLAUDE_POST_RUN=0), so nothing was committed.`
            : `ℹ️ #${issue.number}${issue.title ? ` — ${issue.title}` : ''}: the agent made no changes.`;
      }
      if (result === 'failed' || result === 'timeout') message += `\nLog: ${logPath}`;
      return { result, message, silent, post };
    },

    /**
     * Startup recovery for an issue run that died with the runner: WIP-commit its leftover work so
     * a re-run resumes on the branch. Only on that issue's own branch, never the default branch.
     * @param {{ repo: string, issueNumber: number }} p
     * @returns {Promise<{ ok: boolean, sha?: string, branch?: string, reason?: 'clean' | 'not_issue_branch' | 'git_error', error?: string }>}
     */
    async commitInterruptedWork({ repo, issueNumber }) {
      try {
        const branch = await git.currentBranch(repo);
        if (!(await git.statusPorcelain(repo))) return { ok: false, reason: 'clean', branch };
        if (!git.isIssueBranch(branch, issueNumber)) return { ok: false, reason: 'not_issue_branch', branch };
        const wip = await git.commitWip(repo, issueNumber);
        return wip.ok ? { ok: true, sha: wip.sha, branch } : { ok: false, reason: 'git_error', branch, error: wip.error || wip.reason };
      } catch (err) {
        return { ok: false, reason: 'git_error', error: errorMessageFromUnknown(err) };
      }
    },
  };
}

/** @typedef {ReturnType<typeof createIssuePipeline>} IssuePipeline */
