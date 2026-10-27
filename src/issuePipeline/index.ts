/**
 * The GitHub issue pipeline behind `claude issue:<alias>:<n>` and the cron tracer: the two
 * share `prepare` (fetch the issue, branch in place, build the prompt, with resume context) and
 * `finish` (post-run, then one short outbox message). The runner owns the lock and the agent
 * process in between.
 */

import { appendFile } from 'fs/promises';
import { createExec } from './exec.ts';
import { createGithubIssues } from './githubIssue.ts';
import { createGitWorkspace } from './gitWorkspace.ts';
import { createGithubPr } from './githubPr.ts';
import { createLlm } from './llm.ts';
import { createGmailSender } from './mailer.ts';
import { createPostRun } from './postRun.ts';
import { errorText, recordOrEmpty } from '../narrow.ts';
import { REQUEUED_NOTE } from '../runQueue.ts';
import type { AgentResult } from '../agentBackend/index.ts';
import type { PostRunResult, RunAgent } from './postRun.ts';
import type { PipelineSettings } from './settings.ts';
import type { Exec } from './exec.ts';
import type { FetchLike } from './llm.ts';
import type { SendMail } from './mailer.ts';

export type IssueRef = { number: number; repo: string; title: string };

/** `limited`: the agent (the first pass or the autofix) hit its usage limit, so the run stopped short. */
export type IssueRunResult = 'merged' | 'pr_open' | 'pushed' | 'no_changes' | 'timeout' | 'limited' | 'failed';

export type AgentOutcomeLike = Pick<AgentResult, 'outcome' | 'exitCode' | 'stderr'>;

/** One-line reason the agent itself didn't succeed. */
function agentFailureReason(r: AgentOutcomeLike | undefined) {
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
 * Which pass of an issue run hit the usage limit: the agent's own, or the autofix. Null if neither.
 */
function limitedPass(agent: AgentOutcomeLike | undefined, post: PostRunResult | null): 'agent' | 'autofix' | null {
  if (agent?.outcome === 'limited') return 'agent';
  return post?.postReviewAutofix?.agentOutcome === 'limited' ? 'autofix' : null;
}

/**
 * Short message for a finished issue run: one `✅` line on success, a short `⚠️` naming the
 * problem, a `⏸` for a run the usage limit cut short, or null when there is nothing to report
 * (post-run off, or the agent changed nothing). The full narrative (`post.note`) goes to the run
 * log instead. `requeued` says the runner put the request back at the head of the queue.
 */
export function buildIssueRunMessage({ issue, agentOk, agent, post, postErrMessage = '', trigger = 'manual', requeued = false }: {
    issue: { number: number; title?: string };
    agentOk: boolean;
    agent?: AgentOutcomeLike;
    post: PostRunResult | null;
    postErrMessage?: string;
    trigger?: 'cron' | 'manual';
    requeued?: boolean;
  }): string | null {
  const label = `#${issue.number}${issue.title ? ` — ${issue.title}` : ''}`;
  const attention = (problem: string) => `⚠️ ${label}: ${problem} — needs a look.`;

  const limited = limitedPass(agent, post);
  if (limited) {
    const wip = limited === 'agent' ? post?.wip : post?.postReviewAutofix?.wip;
    return [
      limited === 'agent' ? `⏸ ${label}: the agent hit its usage limit.` : `⏸ ${label}: the autofix pass hit the usage limit.`,
      wip?.ok ? `Its leftover work is committed as WIP \`${wip.sha}\` on its branch.` : '',
      post?.prResult?.ok ? `PR: ${post.prResult.url}.` : '',
      requeued
        ? REQUEUED_NOTE
        : trigger === 'cron'
          ? 'The cron resumes the issue after the reset.'
          : 'Run the issue again after the reset to resume it.',
    ]
      .filter(Boolean)
      .join(' ');
  }

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
  if (post.prAutoMergeResult && !post.prAutoMergeResult.ok) return attention(`auto-merge was not enabled (${post.prAutoMergeResult.error ?? 'unknown error'})`);

  const url = post.prResult?.url ? ` ${post.prResult.url}` : '';
  const title = issue.title ? ` — ${issue.title}` : '';
  // the email comes after the merge, so its failure is a footnote, not the headline
  const email = post.postCloseChangesEmail;
  const emailNote = email && !email.ok ? ` (summary email failed: ${email.step ?? 'unknown step'})` : '';
  const merge = post.prAutoMergeResult;
  if (merge?.ok && (merge.mergedDirectly || post.issueCloseWait?.closed)) return `✅ #${issue.number} merged${title}${emailNote}`;
  if (merge?.ok) return `✅ #${issue.number} merge queued${title}${url}${emailNote}`;
  if (post.prResult?.ok) return `✅ #${issue.number} PR open${title}${url}${emailNote}`;
  return `✅ #${issue.number} pushed${title}${emailNote}`;
}

/**
 * Final result of an issue run, for history and the cron's "did this count as progress".
 */
export function classifyIssueRunResult({ agentOk, agent, post, postErrMessage = '' }: { agentOk: boolean; agent?: AgentOutcomeLike; post: PostRunResult | null; postErrMessage?: string }): IssueRunResult {
  if (limitedPass(agent, post)) return 'limited';
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
 * The review gate let the PR merge, but the merge failed only because GitHub could not be reached.
 * Nothing is wrong with the PR, so the cron works it again rather than setting it aside.
 */
export function mergeFailedOnNetwork(post: PostRunResult | null) {
  const merge = post?.prAutoMergeResult;
  return Boolean(merge && !merge.ok && merge.transientNetwork);
}

/**
 * Resume-prompt section for a branch whose PR is open but never merged. A conflict is resolved by
 * merging (not rebasing) the default branch in, so the fix pushes as a fast-forward.
 */
export function buildOpenPrResumeNote(pr: { url: string; state: string }, defaultBranch: string) {
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

function resumeSection({ branchName, resumeNote, openPrNote }: { branchName: string; resumeNote: string; openPrNote: string }) {
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

export function createIssuePipeline({ settings, exec, fetchFn, sendMail, sleep, now, logger = console }: {
    settings: PipelineSettings;
    exec?: Exec;
    fetchFn?: FetchLike;
    sendMail?: SendMail;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    logger?: Pick<Console, 'log'>;
  }) {
  const ex = exec ?? createExec({ timeoutMs: settings.execTimeoutMs, ghBin: settings.ghBin });
  const log = (message: string, detail?: unknown) => {
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
     */
    async prepare({ issueNumber, alias, workspaceRoot, extraInstructions = '' }: { issueNumber: number; alias: string | null; workspaceRoot: string; extraInstructions?: string }): Promise<{ prompt: string; issue: IssueRef; branchName: string; defaultBranch: string; resumed: boolean; preAgentHeadSha: string | null; labels: string[] }> {
      let fetched;
      try {
        fetched = await issues.fetchIssuePrompt({ issueNumber, workspaceRoot, alias, extraInstructions });
      } catch (err) {
        throw new Error(`Failed to read GitHub issue #${issueNumber}: ${errorText(err)}`);
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
        return { prompt, issue, branchName: prep.branchName, defaultBranch: prep.defaultBranch, resumed: prep.resumed, preAgentHeadSha, labels: fetched.labels ?? [] };
      } catch (err) {
        throw new Error(`Git setup for issue #${issueNumber} failed: ${errorText(err)}`);
      }
    },

    /**
     * After the agent exits: post-run, then the one message to send. The long narrative is
     * appended to the run log. Never throws. `requeued`: the usage limit stopped the agent before it
     * started, and the runner re-queued the request.
     * @returns `silent` marks a run with nothing to report (the agent changed nothing), which cron can skip.
     *   `mergeNetworkError` marks an approved PR whose merge failed only on a network error.
     */
    async finish({ repo, prompt, issue, agent, preAgentHeadSha, logPath, runAgent, trigger = 'manual', requeued = false }: {
        repo: string;
        prompt: string;
        issue: IssueRef;
        agent: AgentOutcomeLike;
        preAgentHeadSha: string | null;
        logPath: string;
        runAgent: RunAgent;
        trigger?: 'cron' | 'manual';
        requeued?: boolean;
      }): Promise<{ result: IssueRunResult; message: string; silent: boolean; mergeNetworkError: boolean; post: PostRunResult }> {
      const agentOk = agent.outcome === 'success';
      let post: PostRunResult;
      let postErrMessage = '';
      try {
        post = await postRun.runPostRun({ repo, userPrompt: prompt, agentOk, issueNumber: issue.number, preAgentHeadSha, runAgent, trigger });
      } catch (err) {
        postErrMessage = errorText(err);
        post = { ran: false, note: '', skipReason: 'post_run_threw' };
        log('post-run threw', recordOrEmpty(err).stack || postErrMessage);
      }
      const result = classifyIssueRunResult({ agentOk, agent, post, postErrMessage });
      const report = [post.note, postErrMessage && `Post-run pipeline failed: ${postErrMessage}`].filter(Boolean).join('\n\n');
      if (report) await appendFile(logPath, `\n\n--- post-run report ---\n${report}\n`).catch(() => {});

      const built = buildIssueRunMessage({ issue, agentOk, agent, post, postErrMessage, trigger, requeued });
      const silent = built == null;
      let message =
        built ??
        (post.skipReason === 'disabled'
          ? `ℹ️ #${issue.number}: the agent finished; post-run is off (CLAUDE_POST_RUN=0), so nothing was committed.`
          : `ℹ️ #${issue.number}${issue.title ? ` — ${issue.title}` : ''}: the agent made no changes.`);
      if (result === 'failed' || result === 'timeout' || result === 'limited') message += `\nLog: ${logPath}`;
      return { result, message, silent, mergeNetworkError: mergeFailedOnNetwork(post), post };
    },

    /**
     * Startup recovery for an issue run that died with the runner: WIP-commit its leftover work so
     * a re-run resumes on the branch. Only on that issue's own branch, never the default branch.
     */
    async commitInterruptedWork({ repo, issueNumber }: { repo: string; issueNumber: number }): Promise<{ ok: boolean; sha?: string; branch?: string; reason?: 'clean' | 'not_issue_branch' | 'git_error'; error?: string }> {
      try {
        const branch = await git.currentBranch(repo);
        if (!(await git.statusPorcelain(repo))) return { ok: false, reason: 'clean', branch };
        if (!git.isIssueBranch(branch, issueNumber)) return { ok: false, reason: 'not_issue_branch', branch };
        const wip = await git.commitWip(repo, issueNumber);
        return wip.ok ? { ok: true, sha: wip.sha, branch } : { ok: false, reason: 'git_error', branch, error: wip.error || wip.reason };
      } catch (err) {
        return { ok: false, reason: 'git_error', error: errorText(err) };
      }
    },
  };
}

export type IssuePipeline = ReturnType<typeof createIssuePipeline>;
