import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  VERDICT_APPROVE,
  VERDICT_REQUEST_CHANGES,
  autoMergeAllowedByReviewGate,
  pickPrResultAfterGhFlow,
  normalizePrReviewComment,
  parseAutofixNoChanges,
} from '../src/issuePipeline/decisionLogic.js';
import { pollGithubIssueClosedOrTimeout } from '../src/issuePipeline/issueClosePoll.js';
import { runPostReviewAutofixMergeFlow } from '../src/issuePipeline/reviewFollowUp.js';

describe('post-run decision logic', () => {
  it('VERDICT: APPROVE with successful review enables auto-merge gate without autofix', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_APPROVE,
        postReviewAutofix: null,
      }),
      true
    );
  });

  it('VERDICT: REQUEST_CHANGES does not enable auto-merge until autofix succeeds', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: null,
      }),
      false
    );
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: false, mergeBlocked: true },
      }),
      false
    );
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: true, mergeBlocked: false },
      }),
      true
    );
  });

  it('an autofix decline (AUTOFIX_NO_CHANGES) overrules REQUEST_CHANGES and allows auto-merge', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: false, mergeBlocked: false, noChanges: true },
      }),
      true
    );
  });

  it('autofix failure / no-op path blocks auto-merge (mergeBlocked implies ok false)', () => {
    assert.equal(
      autoMergeAllowedByReviewGate({
        reviewOutcome: 'success',
        reviewVerdict: VERDICT_REQUEST_CHANGES,
        postReviewAutofix: { ok: false, mergeBlocked: true, detail: 'no changes' },
      }),
      false
    );
  });

  it('PR "already exists" still yields a usable PR URL via recovery', () => {
    const picked = pickPrResultAfterGhFlow({
      listedOk: false,
      createOk: false,
      createError: 'GraphQL: A pull request already exists for cursor:branch',
      recoveredUrl: 'https://github.com/o/r/pull/99',
    });
    assert.equal(picked.ok, true);
    assert.equal(picked.url, 'https://github.com/o/r/pull/99');
    assert.equal(picked.prOutcome, 'recovered');
  });

  it('normalizePrReviewComment defaults invalid first lines to REQUEST_CHANGES', () => {
    const n = normalizePrReviewComment('not a verdict\n\nbody');
    assert.equal(n.verdict, VERDICT_REQUEST_CHANGES);
    assert.match(n.fullComment, /VERDICT: REQUEST_CHANGES/);
  });
});

describe('issue close polling (no live GitHub)', () => {
  it('times out without throwing when the issue never closes', async () => {
    let t = 0;
    const now = () => t;
    const sleep = mock.fn(async (ms) => {
      t += ms;
    });
    const fetchState = async () => ({ ok: true, state: 'OPEN' });
    const result = await pollGithubIssueClosedOrTimeout({
      maxWaitMs: 45,
      pollMs: 10,
      fetchState,
      sleep,
      now,
    });
    assert.equal(result.closed, false);
    assert.equal(result.timedOut, true);
    assert.ok(result.waitedMs >= 45);
    assert.ok(sleep.mock.callCount() >= 4);
  });

  it('returns closed when fetchState reports CLOSED before timeout', async () => {
    let n = 0;
    const fetchState = async () => {
      n++;
      return n >= 2 ? { ok: true, state: 'CLOSED' } : { ok: true, state: 'OPEN' };
    };
    const result = await pollGithubIssueClosedOrTimeout({
      maxWaitMs: 500,
      pollMs: 0,
      fetchState,
      sleep: async () => {},
      now: () => 0,
    });
    assert.equal(result.closed, true);
    assert.equal(result.timedOut, false);
  });
});

describe('runPostReviewAutofixMergeFlow (mocked gh + agent)', () => {
  it('REQUEST_CHANGES triggers exactly one autofix invocation', async () => {
    let autofixCalls = 0;
    const runSinglePostReviewAutofix = async () => {
      autofixCalls++;
      return { ok: true, mergeBlocked: false, detail: 'ok' };
    };
    const tryGhPrQueueAutoMerge = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({
      closed: false,
      timedOut: true,
      waitedMs: 0,
      polls: 0,
    }));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 15,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/1' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_REQUEST_CHANGES,
      reviewBodyMarkdown: 'fix it',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrQueueAutoMerge,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(autofixCalls, 1);
    assert.equal(tryGhPrQueueAutoMerge.mock.callCount(), 1);
  });

  it('REQUEST_CHANGES with autofix mergeBlocked skips auto-merge', async () => {
    const runSinglePostReviewAutofix = async () => ({
      ok: false,
      mergeBlocked: true,
      detail: 'Autofix finished but **git detected no file changes**',
    });
    const tryGhPrQueueAutoMerge = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({}));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 2,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/2' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_REQUEST_CHANGES,
      reviewBodyMarkdown: 'x',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrQueueAutoMerge,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(tryGhPrQueueAutoMerge.mock.callCount(), 0);
    assert.ok(tryGhPrReviewComment.mock.callCount() >= 1);
  });

  it('autofix declining with noChanges posts its reasoning and auto-merges the PR as is', async () => {
    const tryGhPrQueueAutoMerge = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async (_repo, _url, _body) => ({ ok: true }));
    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 2,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/2' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_REQUEST_CHANGES,
      reviewBodyMarkdown: 'x',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix: async () => ({
        ok: false,
        mergeBlocked: false,
        noChanges: true,
        detail: 'made **no changes**: false positive',
      }),
      tryGhPrReviewComment,
      tryGhPrQueueAutoMerge,
      waitForGithubIssueClosed: async () => ({}),
      logPost: () => {},
    });
    assert.equal(tryGhPrQueueAutoMerge.mock.callCount(), 1);
    const body = tryGhPrReviewComment.mock.calls[0].arguments[2];
    assert.match(body, /disagreed with the review/);
    assert.match(body, /false positive/);
    assert.match(body, /proceeds to auto-merge unchanged/);
    assert.doesNotMatch(body, /autofix failed/);
  });

  it('APPROVE runs auto-merge without calling autofix', async () => {
    const runSinglePostReviewAutofix = mock.fn(async () => ({ ok: true, mergeBlocked: false, detail: '' }));
    const tryGhPrQueueAutoMerge = mock.fn(async () => ({ ok: true }));
    const tryGhPrReviewComment = mock.fn(async () => ({ ok: true }));
    const waitForGithubIssueClosed = mock.fn(async () => ({
      closed: false,
      timedOut: true,
      waitedMs: 1,
      polls: 1,
    }));

    await runPostReviewAutofixMergeFlow({
      repo: '/tmp/repo',
      issueNum: 3,
      userPrompt: 'x',
      prResult: { ok: true, url: 'https://github.com/o/r/pull/3' },
      reviewOutcome: 'success',
      reviewVerdict: VERDICT_APPROVE,
      reviewBodyMarkdown: '',
      postReviewAutofixEnabled: () => true,
      prAutoMergeAfterReviewEnabled: () => true,
      prAfterPushEnabled: () => true,
      commitOk: true,
      pushResultOk: true,
      runSinglePostReviewAutofix,
      tryGhPrReviewComment,
      tryGhPrQueueAutoMerge,
      waitForGithubIssueClosed,
      logPost: () => {},
    });

    assert.equal(runSinglePostReviewAutofix.mock.callCount(), 0);
    assert.equal(tryGhPrQueueAutoMerge.mock.callCount(), 1);
  });
});

describe('parseAutofixNoChanges', () => {
  it('returns the reason after the sentinel', () => {
    assert.equal(
      parseAutofixNoChanges('I checked.\n\nAUTOFIX_NO_CHANGES: the mask is already correct.\nSecond line.'),
      'the mask is already correct.\nSecond line.'
    );
  });
  it('tolerates markdown decoration', () => {
    assert.equal(parseAutofixNoChanges('**AUTOFIX_NO_CHANGES:** false positive'), 'false positive');
  });
  it('returns null when absent', () => {
    assert.equal(parseAutofixNoChanges('Pushed a fix.'), null);
    assert.equal(parseAutofixNoChanges(undefined), null);
  });
});

describe('post-close changes email', () => {
  it('names the issue in the subject and a header, then the summary unchanged', async () => {
    const { buildPostCloseChangesEmail } = await import('../src/issuePipeline/mailer.js');
    const e = buildPostCloseChangesEmail({
      subjectPrefix: 'bot',
      issueNumber: 12,
      title: '  Fix  the <thing>  ',
      issueUrl: 'https://github.com/o/r/issues/12',
      prUrl: 'https://github.com/o/r/pull/13',
      summary: 'Did it.',
    });
    assert.equal(e.subject, '[bot] Issue #12 closed: Fix the <thing>');
    assert.equal(e.text, 'Issue #12: Fix the <thing>\nIssue: https://github.com/o/r/issues/12\nPull request: https://github.com/o/r/pull/13\n\n---\n\nDid it.');
    assert.match(e.html, /<h2>Issue #12: Fix the &lt;thing&gt;<\/h2>/);
    assert.match(e.html, /<a href="https:\/\/github.com\/o\/r\/pull\/13">/);
  });

  it('falls back to the old subject without a title, and clips a long one', async () => {
    const { buildPostCloseChangesEmail } = await import('../src/issuePipeline/mailer.js');
    assert.equal(buildPostCloseChangesEmail({ subjectPrefix: 'bot', issueNumber: 1, summary: 's' }).subject, '[bot] Issue #1 closed — changes summary');
    const long = buildPostCloseChangesEmail({ subjectPrefix: 'bot', issueNumber: 1, title: 'x'.repeat(100), summary: 's' }).subject;
    assert.ok(long.endsWith('…') && long.length === '[bot] Issue #1 closed: '.length + 80, long);
  });
});

describe('PR description', () => {
  it('says whether the cron or a claude issue: command opened it', async () => {
    const { buildPrBody } = await import('../src/issuePipeline/postRun.js');
    const wb = { branchName: 'claude/issue-3-x', prBase: 'main' };
    assert.match(buildPrBody(3, wb, 'p', 'cron'), /^Fixes #3\n\nOpened automatically by the cron issue tracer \(`ready-for-agent` label\)/);
    assert.match(buildPrBody(3, wb, 'p'), /^Fixes #3\n\nOpened automatically after a `claude issue:…` run/);
  });
});
