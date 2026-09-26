import { basename } from 'path';
import { autoMergeAllowedByReviewGate, ghMessageLooksLikePrAlreadyExists, normalizePrReviewComment, parseAutofixNoChanges, pickPrResultAfterGhFlow } from './decisionLogic.js';
import { runPostReviewAutofixMergeFlow } from './reviewFollowUp.js';
import { githubMergeMethodSummaryLabel } from './githubPr.js';
import { truncate } from './gitWorkspace.js';
import { buildPostCloseChangesEmail } from './mailer.js';

/**
 * Everything after the agent exits on an issue run: commit, push, open (or reuse) the PR, LLM
 * review posted as a PR comment, one autofix pass on `VERDICT: REQUEST_CHANGES`, merge when the
 * review gate passes, wait for the issue to close, the summary email, and back to the default
 * branch. Each step can be turned off with its `CLAUDE_POST_RUN*` flag.
 *
 * @typedef {{
 *   ran: boolean,
 *   note: string,
 *   skipReason?: string,
 *   commit?: import('./gitWorkspace.js').CommitResult,
 *   workBranch?: { didCheckoutNew: boolean, branchName: string, prBase: string },
 *   pushResult?: { ok: boolean, error?: string } | null,
 *   prResult?: { ok: boolean, url?: string, error?: string } | null,
 *   prOutcome?: 'listed' | 'created' | 'recovered' | null,
 *   prCommentResult?: { ok: boolean, error?: string, skipped?: boolean } | null,
 *   reviewOutcome?: string,
 *   review?: string,
 *   reviewVerdict?: string,
 *   postReviewAutofix?: AutofixResult | null,
 *   prAutoMergeResult?: import('./githubPr.js').MergeResult | null,
 *   issueCloseWait?: { closed?: boolean, timedOut?: boolean } | null,
 *   postCloseChangesEmail?: { ok: boolean, to?: string, error?: string, step?: string } | null,
 *   returnToDefaultBranch?: { ok: boolean, defaultBranch?: string, reason?: string, error?: string } | null,
 *   wip?: import('./gitWorkspace.js').CommitResult,
 * }} PostRunResult
 *
 * @typedef {{
 *   ok: boolean,
 *   mergeBlocked: boolean,
 *   noChanges?: boolean,
 *   noChangesReason?: string,
 *   detail: string,
 *   commit?: import('./gitWorkspace.js').CommitResult,
 *   pushResult?: { ok: boolean, error?: string },
 *   agentOutcome?: string,
 * }} AutofixResult
 *
 * @typedef {(p: { prompt: string, label: string }) => Promise<Pick<import('../agentBackend/index.js').AgentResult, 'outcome' | 'exitCode' | 'text' | 'stderr'>>} RunAgent
 *   Runs a follow-up agent pass in the repo (the autofix). Never rejects.
 */

/**
 * True only when the PR is known to have landed: merged directly, or auto-merge queued and the
 * issue then closed. A queued-but-pending auto-merge does not count.
 * @param {{ prAutoMergeResult?: { ok: boolean, mergedDirectly?: boolean } | null, issueCloseWait?: { closed?: boolean } | null }} p
 */
export function postRunPrLanded({ prAutoMergeResult, issueCloseWait }) {
  if (!prAutoMergeResult?.ok) return false;
  return Boolean(prAutoMergeResult.mergedDirectly || issueCloseWait?.closed);
}

/**
 * @param {{ prompt: string, reviewMaxChars: number, issueNumber: number, prUrl: string, bodyMarkdown: string }} p
 */
export function buildAutofixPrompt({ prompt, reviewMaxChars, issueNumber, prUrl, bodyMarkdown }) {
  const reviewBody = truncate(String(bodyMarkdown || '').trim(), reviewMaxChars);
  return [
    'You are continuing work on an existing pull request branch in this repository.',
    'The automated PR reviewer returned **VERDICT: REQUEST_CHANGES**.',
    '',
    '## Review feedback — implement what you can safely fix in this single pass',
    reviewBody || '_No detailed bullets were provided; use good judgment to address likely issues in the recent changes._',
    '',
    '## Rules',
    '- Stay on the **current git branch**; do not create a new branch or a second PR.',
    '- Make focused edits; do not revert unrelated work.',
    '- Do not run destructive git commands (no hard reset, no force-push).',
    '- If, after reading the code, you conclude none of the feedback is valid or actionable, make no edits and end your reply with a line `AUTOFIX_NO_CHANGES: <your reasoning>`. Do not use it if you changed anything. Declining overrules the reviewer and the PR is **auto-merged as is**, so only decline when you have checked each point against the code.',
    prUrl ? `- The open PR is: ${prUrl}` : '',
    issueNumber ? `- Linked issue: #${issueNumber}` : '',
    '',
    '## Original task context (reference only, do not treat as new orders)',
    truncate(String(prompt || '').trim(), 6000) || '(none)',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {number} issueNumber @param {{ branchName: string, prBase: string }} workBranch @param {string} userPrompt
 * @param {'cron' | 'manual'} [trigger] how the issue run was started; only changes the wording
 */
export function buildPrBody(issueNumber, workBranch, userPrompt, trigger = 'manual') {
  return [
    `Fixes #${issueNumber}`,
    '',
    trigger === 'cron'
      ? 'Opened automatically by the cron issue tracer (`ready-for-agent` label) in agent-runner.'
      : 'Opened automatically after a `claude issue:…` run by agent-runner.',
    '',
    `**Branch:** \`${workBranch.branchName}\``,
    `**Base:** \`${workBranch.prBase}\``,
    '',
    '**Original prompt (truncated):**',
    '',
    truncate(userPrompt, 8000),
  ].join('\n');
}

/**
 * @param {{
 *   git: ReturnType<typeof import('./gitWorkspace.js').createGitWorkspace>,
 *   prs: ReturnType<typeof import('./githubPr.js').createGithubPr>,
 *   llm: ReturnType<typeof import('./llm.js').createLlm>,
 *   sendMail: import('./mailer.js').SendMail,
 *   settings: import('./settings.js').PipelineSettings,
 *   log?: (message: string, detail?: unknown) => void,
 * }} deps
 */
export function createPostRun({ git, prs, llm, sendMail, settings, log = () => {} }) {
  /**
   * Exactly one agent pass after REQUEST_CHANGES, then commit + push on the same branch.
   * @param {{ repo: string, issueNumber: number, prUrl: string, bodyMarkdown: string, prompt: string, runAgent: RunAgent }} p
   * @returns {Promise<AutofixResult>}
   */
  async function runAutofix({ repo, issueNumber, prUrl, bodyMarkdown, prompt, runAgent }) {
    log('post-review autofix: starting a single agent pass', { issueNumber });
    const pre = await git.headSha(repo).catch(() => '');
    const agent = await runAgent({
      prompt: buildAutofixPrompt({ prompt, reviewMaxChars: settings.review.autofixReviewMaxChars, issueNumber, prUrl, bodyMarkdown }),
      label: 'autofix',
    });
    const agentOutcome = agent.outcome;
    if (agent.outcome !== 'success') {
      const detail =
        agent.outcome === 'timeout'
          ? 'Autofix timed out.'
          : agent.outcome === 'stopped'
            ? 'Autofix was stopped.'
            : agent.outcome === 'spawn_error'
              ? `Autofix could not start: ${agent.stderr}`
              : `Autofix exited with code ${agent.exitCode ?? 'n/a'}.`;
      return { ok: false, mergeBlocked: true, detail, agentOutcome };
    }

    const wait = await git.waitForAgentActivity(repo, pre || null);
    if (!wait.dirty && !wait.headMoved) {
      const noChangesReason = parseAutofixNoChanges(agent.text);
      if (noChangesReason) {
        return {
          ok: false,
          mergeBlocked: false,
          noChanges: true,
          noChangesReason,
          detail: `Autofix agent reviewed the feedback and made **no changes**:\n\n${truncate(noChangesReason, 3000)}`,
          agentOutcome,
        };
      }
      return {
        ok: false,
        mergeBlocked: true,
        detail: 'Autofix finished but **git detected no new commits and no uncommitted changes** after waiting — treat as failed for merge purposes.',
        agentOutcome,
      };
    }

    /** @type {import('./gitWorkspace.js').CommitResult} */
    let commit;
    if (wait.dirty) {
      commit = await git.commitWork(repo, `# GitHub issue #${issueNumber}\n\n**Title:** address automated PR review feedback`);
      if (!commit.ok) {
        return {
          ok: false,
          mergeBlocked: true,
          detail: `Autofix made edits but commit failed (${commit.reason}${commit.error ? `: ${commit.error}` : ''}).`,
          agentOutcome,
        };
      }
    } else {
      commit = { ok: true, sha: await git.headShaShort(repo), message: await git.lastCommitSubject(repo) };
    }
    if (!settings.push) {
      return {
        ok: false,
        mergeBlocked: true,
        detail: 'Autofix committed locally but **push is disabled** (`CLAUDE_POST_RUN_PUSH=0`) — push manually to update the PR.',
        commit,
        agentOutcome,
      };
    }
    if (!(await git.hasOrigin(repo))) {
      return { ok: false, mergeBlocked: true, detail: 'Autofix committed locally but there is **no `origin` remote** — push manually.', commit, agentOutcome };
    }
    const pushResult = await git.pushHead(repo);
    if (!pushResult.ok) {
      return { ok: false, mergeBlocked: true, detail: `Autofix commit ${commit.sha} could not be pushed: ${pushResult.error}`, commit, pushResult, agentOutcome };
    }
    return { ok: true, mergeBlocked: false, detail: `Autofix applied one pass, committed \`${commit.sha}\`, and pushed to origin.`, commit, pushResult, agentOutcome };
  }

  /** @param {string} repo @param {number} issueNumber @param {string | undefined} prUrl */
  async function sendIssueClosedEmail(repo, issueNumber, prUrl) {
    const details = await prs.issueDetails(repo, issueNumber);
    if (!details.ok) return { ok: false, step: 'gh_issue_view', error: details.error };
    if (details.state !== 'CLOSED') return { ok: false, step: 'issue_state', error: `Expected GitHub state CLOSED, got "${details.state}".` };
    const issueBlock = [
      `Issue #${issueNumber} [${details.state}]`,
      '',
      `Title: ${details.title}`,
      '',
      'Description:',
      truncate(details.body, settings.summary.issueBodyMaxChars),
      prUrl ? `\n\nRelated pull request (context only): ${prUrl}` : '',
    ].join('\n');
    const summary = await llm.issueClosedSummary(issueBlock);
    if (!summary.ok) return { ok: false, step: 'deepinfra', error: summary.error };
    const prefix = settings.email.subjectPrefix || basename(repo.replace(/\/+$/, '')) || 'agent-runner';
    const email = buildPostCloseChangesEmail({ subjectPrefix: prefix, issueNumber, title: details.title, issueUrl: details.url, prUrl, summary: summary.text });
    const mail = await sendMail(email.subject, { text: email.text, html: email.html });
    return mail.ok ? { ok: true, to: mail.to, step: 'sent' } : { ok: false, step: 'smtp', error: mail.error };
  }

  /**
   * @param {{
   *   repo: string,
   *   userPrompt: string,
   *   agentOk: boolean,
   *   issueNumber: number,
   *   preAgentHeadSha?: string | null,
   *   runAgent: RunAgent,
   *   trigger?: 'cron' | 'manual',
   * }} p
   *   `trigger` (how the issue run was started) only changes the PR description wording.
   * @returns {Promise<PostRunResult>}
   */
  async function runPostRun({ repo, userPrompt, agentOk, issueNumber, preAgentHeadSha = null, runAgent, trigger = 'manual' }) {
    log('start', { repo, agentOk, issueNumber, preAgentHeadSha: preAgentHeadSha ? `${preAgentHeadSha.slice(0, 7)}…` : null });
    if (!settings.postRun) return { ran: false, note: '', skipReason: 'disabled' };

    if (!agentOk) {
      // leave the tree clean on the issue branch so the next run resumes instead of refusing
      if (await git.statusPorcelain(repo).catch(() => '')) {
        const wip = await git.commitWip(repo, issueNumber);
        if (wip.ok) {
          return {
            ran: true,
            note: `The agent did not finish but left uncommitted work, so it was committed as a WIP snapshot (\`${wip.sha}\`) on this branch for the next run to resume. No push or PR yet.`,
            skipReason: 'agent_not_ok_wip_committed',
            wip,
          };
        }
        log('agent not ok: WIP commit failed', wip.error || wip.reason);
      }
      return { ran: false, note: '', skipReason: 'agent_not_ok' };
    }

    let wait = await git.waitForAgentActivity(repo, preAgentHeadSha);
    /** Set when the agent changed nothing but this branch already has an open PR to finish. */
    let existingPr = null;
    /** Set when the agent changed nothing but the branch holds commits no PR carries yet. */
    let unpushedCommits = 0;
    if (!wait.dirty && !wait.headMoved) {
      existingPr = await prs.findOpenPrForBranch(repo, await git.currentBranch(repo).catch(() => ''));
      if (!existingPr) unpushedCommits = await git.commitsAheadOfDefault(repo);
      if (!existingPr && !unpushedCommits) return { ran: false, note: '', skipReason: 'clean_after_wait' };
      // Earlier work is committed (killed before push, or its PR was held by the review gate):
      // finish it, reviewing the whole branch against the PR base as if the agent had committed.
      log(existingPr ? 'no new git activity, but the branch has an open PR; re-reviewing it' : 'no new git activity, but unpushed commits; pushing them', existingPr ?? unpushedCommits);
      wait = { ...wait, headMoved: true };
    }

    let workBranch;
    try {
      workBranch = await git.prepareWorkBranch(repo);
    } catch (e) {
      const err = e?.stderr || e?.message || String(e);
      return { ran: true, note: `Could not prepare a feature branch: ${err}. No commit was made.`, skipReason: 'branch_prep_failed' };
    }

    /** @type {import('./gitWorkspace.js').CommitResult} */
    const commit = wait.dirty
      ? await git.commitWork(repo, userPrompt)
      : { ok: true, sha: await git.headShaShort(repo), message: await git.lastCommitSubject(repo) };
    log('commit', commit);

    const diff = await git.reviewDiffText(repo, workBranch, wait, preAgentHeadSha, commit.ok);
    if (!diff.trim()) {
      return { ran: true, note: 'Git activity was detected but no diff text could be read for review (try a manual push/PR).', skipReason: 'empty_diff' };
    }

    let pushResult = null;
    let prResult = null;
    /** @type {'listed' | 'created' | 'recovered' | null} */
    let prOutcome = null;
    if (commit.ok && settings.push) {
      pushResult = (await git.hasOrigin(repo))
        ? await git.pushHead(repo)
        : { ok: false, error: 'no git remote named `origin` — cannot push (add origin or push manually).' };
      log('push', pushResult);
      if (pushResult.ok && settings.pr) {
        const listed = await prs.listOpenPrForHead(repo, { head: workBranch.branchName, base: workBranch.prBase });
        if (listed.ok && listed.url) {
          prResult = { ok: true, url: listed.url };
          prOutcome = 'listed';
        } else {
          if (!listed.ok) log('gh pr list failed (will still try pr create)', listed.error);
          const title = commit.message || 'agent-runner update';
          const created = await prs.createPr(repo, {
            base: workBranch.prBase,
            title: title.length > 200 ? `${title.slice(0, 197)}…` : title,
            body: buildPrBody(issueNumber, workBranch, userPrompt, trigger),
          });
          const recoveredUrl = !created.ok && ghMessageLooksLikePrAlreadyExists(created.error) ? await prs.firstOpenPrUrlForHead(repo, workBranch.branchName) : null;
          const picked = pickPrResultAfterGhFlow({ listedOk: false, createOk: created.ok, createUrl: created.url, createError: created.error, recoveredUrl });
          prResult = picked.ok && picked.url ? { ok: true, url: picked.url } : created;
          prOutcome = picked.ok && picked.url ? picked.prOutcome : null;
        }
        log('pr', { prResult, prOutcome });
      }
    }

    const llmOut = await llm.review(diff, userPrompt);
    const { fullComment: review, verdict: reviewVerdict, bodyMarkdown } = normalizePrReviewComment(llmOut.text);
    const reviewOutcome = llmOut.outcome;
    log('LLM review', { outcome: reviewOutcome, reviewVerdict, model: llmOut.model, tokens: llmOut.usage.total });

    let prCommentResult = null;
    if (prResult?.ok) {
      prCommentResult =
        reviewOutcome === 'success'
          ? await prs.comment(repo, prResult.url, review)
          : { ok: false, skipped: true, error: `Review did not complete (${reviewOutcome}); PR comment not posted.` };
    }

    const { postReviewAutofix, prAutoMergeResult, issueCloseWait } = await runPostReviewAutofixMergeFlow({
      repo,
      issueNum: issueNumber,
      userPrompt,
      prResult,
      reviewOutcome,
      reviewVerdict,
      reviewBodyMarkdown: bodyMarkdown,
      postReviewAutofixEnabled: () => settings.autofix,
      prAutoMergeAfterReviewEnabled: () => settings.autoMerge,
      prAfterPushEnabled: () => settings.pr,
      commitOk: commit.ok,
      pushResultOk: Boolean(pushResult?.ok),
      runSinglePostReviewAutofix: (p) => runAutofix({ repo, issueNumber, prUrl: p.prUrl, bodyMarkdown: p.bodyMarkdown, prompt: userPrompt, runAgent }),
      tryGhPrReviewComment: prs.comment,
      tryGhPrQueueAutoMerge: prs.queueAutoMerge,
      waitForGithubIssueClosed: prs.waitForIssueClosed,
      logPost: log,
    });

    const postCloseChangesEmail = issueCloseWait?.closed ? await sendIssueClosedEmail(repo, issueNumber, prResult?.url) : null;
    if (postCloseChangesEmail) log('post-close email', postCloseChangesEmail);

    // merged → done with the issue branch; otherwise stay on it so the next run resumes it
    const returnToDefaultBranch = postRunPrLanded({ prAutoMergeResult, issueCloseWait }) ? await git.returnToDefaultBranch(repo) : null;

    const parts = [];
    if (existingPr) parts.push(`The agent made no new changes; re-reviewed the open PR ${existingPr.url} (${existingPr.state}).`);
    else if (unpushedCommits > 0) parts.push(`The agent made no new changes; picked up ${unpushedCommits} commit(s) an earlier run left unpushed.`);
    if (commit.ok) {
      if (!existingPr) {
        parts.push(
          wait.dirty
            ? `Committed ${commit.sha} on \`${workBranch.branchName}\`: ${commit.message}`
            : `Agent already committed \`${commit.sha}\` on \`${workBranch.branchName}\`: ${commit.message}`
        );
      }
      if (workBranch.didCheckoutNew) parts.push('(Created a new branch so this did not commit directly to the default branch.)');
      if (pushResult?.ok) parts.push('Pushed to origin.');
      else if (pushResult) {
        parts.push(`Push to origin failed: ${pushResult.error}`);
        if (settings.pr) parts.push('Creating a GitHub PR was skipped because the branch is not on the remote.');
      }
      if (prResult?.ok) {
        parts.push(prOutcome === 'listed' || prOutcome === 'recovered' ? `Pull request already open for this branch: ${prResult.url}` : `Opened pull request: ${prResult.url}`);
        if (prCommentResult?.ok) parts.push(`Posted one PR-level LLM review comment on GitHub (first line: \`${review.split('\n')[0]}\`).`);
        else if (prCommentResult?.skipped) parts.push(`GitHub PR review comment was not posted: ${prCommentResult.error}`);
        else if (prCommentResult) parts.push(`GitHub PR review comment failed: ${prCommentResult.error}.`);
      } else if (prResult) {
        parts.push(`Pull request could not be created (${prResult.error}). Fix GitHub CLI auth (\`gh auth status\`) or network, then push and open a PR manually if needed.`);
      }
    } else {
      parts.push(`Auto-commit did not complete (${commit.reason}${commit.error ? `: ${commit.error}` : ''}). Diff was still reviewed.`);
    }
    if (postReviewAutofix) {
      parts.push(postReviewAutofix.detail);
      if (postReviewAutofix.mergeBlocked) {
        parts.push('**Merge note:** do not merge until the autofix problem above is resolved (a merge-gate comment was attempted on the PR).');
      }
    }
    if (settings.autoMerge && settings.pr && prResult?.ok) {
      if (prAutoMergeResult) {
        const method = prAutoMergeResult.mergeMethod ? ` (${githubMergeMethodSummaryLabel(prAutoMergeResult.mergeMethod)})` : '';
        if (!prAutoMergeResult.ok) parts.push(`GitHub auto-merge${method} was **not** enabled: ${prAutoMergeResult.error || 'unknown error'}.`);
        else if (prAutoMergeResult.mergedDirectly) {
          parts.push(
            `PR was **merged immediately**${method} (no branch-protection gate for auto-merge)${
              issueCloseWait?.closed
                ? `; linked issue **#${issueNumber}** is **closed**.`
                : issueCloseWait?.timedOut
                  ? `, but issue **#${issueNumber}** is still **not closed** after waiting. **Post-close summary email** was not sent.`
                  : '.'
            }`
          );
        } else if (issueCloseWait?.closed) {
          parts.push(`GitHub **auto-merge${method}** was enabled for the PR; linked issue **#${issueNumber}** is **closed**.`);
        } else if (issueCloseWait?.timedOut) {
          parts.push(
            `**Merge pending / issue not yet closed:** auto-merge${method} was requested, but issue **#${issueNumber}** is still **not closed** after waiting (\`CLAUDE_POST_RUN_ISSUE_CLOSE_MAX_WAIT_MS\`). The merge may still complete once checks and branch rules allow; the **post-close summary email** was not sent.`
          );
        }
      } else if (reviewOutcome === 'success' && !autoMergeAllowedByReviewGate({ reviewOutcome, reviewVerdict, postReviewAutofix })) {
        parts.push(
          'Auto-merge was **not** queued: requires **VERDICT: APPROVE**, or **VERDICT: REQUEST_CHANGES** together with a **successful autofix** commit pushed to the PR branch or an autofix decline (`AUTOFIX_NO_CHANGES`).'
        );
      }
    }
    if (postCloseChangesEmail?.ok) parts.push(`**Post-close summary email** sent to ${postCloseChangesEmail.to}.`);
    else if (postCloseChangesEmail) parts.unshift(`**Post-close summary email failed** (step: ${postCloseChangesEmail.step}): ${postCloseChangesEmail.error}`);
    if (returnToDefaultBranch?.ok) parts.push(`Workspace switched back to \`${returnToDefaultBranch.defaultBranch}\`.`);
    else if (returnToDefaultBranch) {
      parts.push(
        `Could not switch the workspace back to the default branch (${returnToDefaultBranch.reason}${returnToDefaultBranch.error ? `: ${returnToDefaultBranch.error}` : ''}); the next issue run will do it.`
      );
    }

    return {
      ran: true,
      note: parts.join(' '),
      commit,
      workBranch,
      pushResult,
      prResult,
      prOutcome,
      prCommentResult,
      reviewOutcome,
      review,
      reviewVerdict,
      postReviewAutofix,
      prAutoMergeResult,
      issueCloseWait,
      postCloseChangesEmail,
      returnToDefaultBranch,
    };
  }

  return { runPostRun, runAutofix };
}
