import {
  VERDICT_REQUEST_CHANGES,
  autoMergeAllowedByReviewGate,
} from './decisionLogic.ts';
import type { MergeResult, PrResult } from './githubPr.ts';
import type { AutofixResult, IssueCloseWait } from './postRun.ts';

export type LogPost = (message: string, detail?: unknown) => void;

/**
 * Post-LLM-review steps: optional single autofix pass, merge-gate PR comment, auto-merge + issue poll.
 * Inject `tryGhPrQueueAutoMerge` (from ./githubPr.ts) so `node:test` can mock `gh` and related helpers.
 */
export async function runPostReviewAutofixMergeFlow({
  repo,
  issueNum,
  userPrompt,
  prResult,
  reviewOutcome,
  reviewVerdict,
  reviewBodyMarkdown,
  postReviewAutofixEnabled,
  prAutoMergeAfterReviewEnabled,
  prAfterPushEnabled,
  commitOk,
  pushResultOk,
  runSinglePostReviewAutofix,
  tryGhPrReviewComment,
  tryGhPrQueueAutoMerge,
  waitForGithubIssueClosed,
  logPost = () => {},
}: {
  repo: string;
  issueNum: number;
  userPrompt: string;
  prResult: PrResult | null;
  reviewOutcome: string;
  reviewVerdict: string;
  reviewBodyMarkdown: string;
  postReviewAutofixEnabled: () => boolean;
  prAutoMergeAfterReviewEnabled: () => boolean;
  prAfterPushEnabled: () => boolean;
  commitOk: boolean;
  pushResultOk: boolean;
  runSinglePostReviewAutofix: (p: { repo: string; issueNum: number; prUrl: string; bodyMarkdown: string; originalUserPrompt: string }) => Promise<AutofixResult>;
  tryGhPrReviewComment: (repo: string, prUrl: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  tryGhPrQueueAutoMerge: (repo: string, prUrl: string) => Promise<MergeResult>;
  waitForGithubIssueClosed: (repo: string, issueNumber: number) => Promise<IssueCloseWait>;
  logPost?: LogPost;
}) {
  let postReviewAutofix: AutofixResult | null = null;
  if (
    postReviewAutofixEnabled() &&
    reviewVerdict === VERDICT_REQUEST_CHANGES &&
    reviewOutcome === 'success'
  ) {
    if (commitOk && pushResultOk && prResult?.ok) {
      postReviewAutofix = await runSinglePostReviewAutofix({
        repo,
        issueNum,
        prUrl: prResult.url,
        bodyMarkdown: reviewBodyMarkdown,
        originalUserPrompt: userPrompt,
      });
      if (postReviewAutofix.noChanges && prResult.ok) {
        const declineBody = [
          '**agent-runner — automated autofix disagreed with the review**',
          '',
          postReviewAutofix.detail,
          '',
          'The agent overruled the review feedback, so the PR proceeds to auto-merge unchanged.',
        ].join('\n');
        const declineComment = await tryGhPrReviewComment(repo, prResult.url, declineBody);
        logPost('post-review autofix decline PR comment', declineComment);
      } else if (postReviewAutofix.mergeBlocked && prResult.ok) {
        const gateBody = [
          '**agent-runner — merge blocked after the autofix**',
          '',
          postReviewAutofix.detail,
          '',
          '**Do not merge** this PR until the review feedback is addressed (manually or with another `claude issue:…` run).',
        ].join('\n');
        const gateComment = await tryGhPrReviewComment(repo, prResult.url, gateBody);
        logPost('post-review autofix merge-gate PR comment', gateComment);
      }
    } else {
      logPost('post-review autofix skipped (needs successful commit, push, and open PR)', {
        commitOk,
        pushOk: Boolean(pushResultOk),
        prOk: Boolean(prResult?.ok),
      });
    }
  }

  let prAutoMergeResult: MergeResult | null = null;
  let issueCloseWait: IssueCloseWait | null = null;
  if (
    prAutoMergeAfterReviewEnabled() &&
    prAfterPushEnabled() &&
    prResult?.ok &&
    autoMergeAllowedByReviewGate({ reviewOutcome, reviewVerdict, postReviewAutofix })
  ) {
    prAutoMergeResult = await tryGhPrQueueAutoMerge(repo, prResult.url);
    logPost('tryGhPrQueueAutoMerge', prAutoMergeResult);
    if (prAutoMergeResult.ok) {
      issueCloseWait = await waitForGithubIssueClosed(repo, issueNum);
      logPost('wait for issue closed', issueCloseWait);
    }
  } else if (prAutoMergeAfterReviewEnabled() && prAfterPushEnabled() && prResult?.ok) {
    logPost('skip auto-merge (review gate)', {
      reviewOutcome,
      reviewVerdict,
      autofixOk: postReviewAutofix?.ok,
    });
  }

  return { postReviewAutofix, prAutoMergeResult, issueCloseWait };
}
