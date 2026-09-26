import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { buildIssueRunMessage, createIssuePipeline, errorMessageFromUnknown } from '../src/issuePipeline/index.js';
import { loadPipelineSettings } from '../src/issuePipeline/settings.js';
import { realExec, realGitFakeGh } from './helpers/fakeExec.js';

const execFileAsync = promisify(execFile);

describe('errorMessageFromUnknown', () => {
  it('uses Error.message', () => {
    assert.equal(errorMessageFromUnknown(new Error('oops')), 'oops');
  });

  it('stringifies non-Error throws', () => {
    assert.equal(errorMessageFromUnknown('boom'), 'boom');
    assert.equal(errorMessageFromUnknown(null), 'null');
  });

  it('reads message from plain object', () => {
    assert.equal(errorMessageFromUnknown({ message: 'from object' }), 'from object');
  });

  it('falls back when message is empty', () => {
    assert.ok(String(errorMessageFromUnknown({ message: '' })).length > 0);
  });
});

describe('buildIssueRunMessage', () => {
  const issue = { number: 114, title: 'Fix the thing' };
  const okPost = {
    ran: true,
    note: 'long narrative with review and changes summary',
    commit: { ok: true },
    pushResult: { ok: true },
    prResult: { ok: true, url: 'https://github.com/o/r/pull/9' },
    prAutoMergeResult: { ok: true, mergedDirectly: true },
    issueCloseWait: { closed: true },
    postCloseChangesEmail: { ok: true },
  };

  it('returns a one-line merged result without the narrative', () => {
    const msg = buildIssueRunMessage({ issue, agentOk: true, post: okPost });
    assert.equal(msg, '✅ #114 merged — Fix the thing');
    assert.ok(!msg.includes('\n'));
  });

  it('returns PR open with url when no merge was queued', () => {
    const msg = buildIssueRunMessage({
      issue,
      agentOk: true,
      post: { ...okPost, prAutoMergeResult: null, issueCloseWait: null, postCloseChangesEmail: null },
    });
    assert.equal(msg, '✅ #114 PR open — Fix the thing https://github.com/o/r/pull/9');
  });

  it('flags agent timeout', () => {
    const msg = buildIssueRunMessage({
      issue,
      agentOk: false,
      agent: { outcome: 'timeout', exitCode: null, stderr: '' },
      post: { ran: false, note: '', skipReason: 'agent_not_ok' },
    });
    assert.match(msg, /^⚠️ #114/);
    assert.match(msg, /timed out/);
  });

  it('mentions the WIP commit left by an unfinished agent', () => {
    const msg = buildIssueRunMessage({
      issue,
      agentOk: false,
      agent: { outcome: 'stopped', exitCode: null, stderr: '' },
      post: { ran: true, note: '', skipReason: 'agent_not_ok_wip_committed', wip: { ok: true, sha: 'abc1234' } },
    });
    assert.match(msg, /stopped by claude:stop/);
    assert.match(msg, /WIP `abc1234`/);
  });

  it('flags a merge blocked by autofix and a failed post-close email', () => {
    assert.match(
      buildIssueRunMessage({ issue, agentOk: true, post: { ...okPost, postReviewAutofix: { ok: false, mergeBlocked: true, detail: 'x' } } }),
      /merge blocked/
    );
    assert.match(buildIssueRunMessage({ issue, agentOk: true, post: { ...okPost, postCloseChangesEmail: { ok: false, step: 'smtp' } } }), /email failed/);
  });

  it('flags a post-run exception and PR creation failure', () => {
    assert.match(
      buildIssueRunMessage({ issue, agentOk: true, post: { ran: false, note: '', skipReason: 'post_run_threw' }, postErrMessage: 'boom' }),
      /post-run pipeline failed \(boom\)/
    );
    assert.match(buildIssueRunMessage({ issue, agentOk: true, post: { ...okPost, prResult: { ok: false, error: 'gh auth' } } }), /PR creation failed/);
  });

  it('stays silent when the agent changed nothing', () => {
    assert.equal(buildIssueRunMessage({ issue, agentOk: true, post: { ran: false, note: '', skipReason: 'clean_after_wait' } }), null);
  });
});

/** @param {string} repo @param {string[]} args */
async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

/** A bare origin with one commit on `main`, and a clone of it to run issues in. */
async function cloneWithOrigin() {
  const origin = await mkdtemp(join(tmpdir(), 'agent-origin-'));
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const repo = await mkdtemp(join(tmpdir(), 'agent-clone-'));
  await execFileAsync('git', ['clone', '-q', origin, repo]);
  await git(repo, ['config', 'user.email', 'test@test.local']);
  await git(repo, ['config', 'user.name', 'test']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await writeFile(join(repo, 'README.md'), 'v0\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await git(repo, ['push', '-q', '-u', 'origin', 'main']);
  await git(repo, ['remote', 'set-head', 'origin', 'main']);
  return { origin, repo };
}

const ISSUE_JSON = JSON.stringify({ number: 7, title: 'Fix it', body: 'Make it work', state: 'OPEN', url: 'https://github.com/o/r/issues/7', labels: [{ name: 'bug' }] });

/**
 * @param {(args: string[]) => string | Promise<string>} gh
 * @param {Record<string, string>} [env]
 * @param {Partial<Parameters<typeof createIssuePipeline>[0]>} [deps]
 */
function pipeline(gh, env = {}, deps = {}) {
  const exec = realGitFakeGh(gh);
  const p = createIssuePipeline({
    settings: loadPipelineSettings({
      CLAUDE_ISSUE_REPO_MAP: 'a=o/r',
      CLAUDE_POST_RUN_LOG: '0',
      CLAUDE_POST_RUN_POLL_MS: '0',
      CLAUDE_POST_RUN_MAX_WAIT_MS: '40',
      CLAUDE_POST_RUN_MERGEABLE_POLL_MS: '0',
      CLAUDE_POST_RUN_ISSUE_CLOSE_POLL_MS: '0',
      CLAUDE_POST_RUN_ISSUE_CLOSE_MAX_WAIT_MS: '1000',
      ...env,
    }),
    exec,
    sendMail: async () => ({ ok: false, error: 'no mail in tests' }),
    ...deps,
  });
  return Object.assign(p, { ghCalls: exec.ghCalls });
}

const issueOnly = (args) => {
  if (args[0] === 'issue' && args[1] === 'view') return ISSUE_JSON;
  if (args[0] === 'pr' && args[1] === 'list') return '[]';
  throw new Error(`unexpected gh ${args.join(' ')}`);
};

describe('issue pipeline: prepare', () => {
  it('fetches the issue and branches in place from an up-to-date main', async () => {
    const { repo } = await cloneWithOrigin();
    const prep = await pipeline(issueOnly).prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    assert.equal(prep.branchName, 'claude/issue-7-fix-it');
    assert.equal(prep.defaultBranch, 'main');
    assert.equal(prep.resumed, false);
    assert.deepEqual(prep.issue, { number: 7, repo: 'o/r', title: 'Fix it' });
    assert.match(prep.prompt, /^# GitHub issue #7/);
    assert.doesNotMatch(prep.prompt, /Resuming/);
    assert.equal(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'claude/issue-7-fix-it');
    assert.equal(prep.preAgentHeadSha, await git(repo, ['rev-parse', 'main']));
  });

  it('uses master when that is the default branch', async () => {
    const { repo } = await cloneWithOrigin();
    await git(repo, ['push', '-q', 'origin', 'main:master']);
    await git(repo, ['remote', 'set-head', 'origin', 'master']);
    const prep = await pipeline(issueOnly).prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    assert.equal(prep.defaultBranch, 'master');
  });

  it('refuses a dirty tree with a message for the user', async () => {
    const { repo } = await cloneWithOrigin();
    await writeFile(join(repo, 'README.md'), 'local edit\n');
    await assert.rejects(pipeline(issueOnly).prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo }), /^Error: Git setup for issue #7 failed: Working tree is not clean/);
  });

  it('reports an unreadable issue', async () => {
    const { repo } = await cloneWithOrigin();
    const p = pipeline(() => {
      throw Object.assign(new Error('gh failed'), { stderr: 'GraphQL: Could not resolve to an issue with the number of 7.' });
    });
    await assert.rejects(p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo }), /Failed to read GitHub issue #7: GraphQL: Could not resolve/);
  });

  it('resumes an unfinished branch with its commits and open PR in the prompt', async () => {
    const { repo } = await cloneWithOrigin();
    const p = pipeline((args) => {
      if (args[0] === 'issue') return ISSUE_JSON;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ url: 'https://github.com/o/r/pull/3' }]);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', state: 'OPEN' });
      throw new Error(`unexpected gh ${args.join(' ')}`);
    });
    await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    await writeFile(join(repo, 'half.txt'), 'half done\n');
    assert.equal((await p.commitInterruptedWork({ repo, issueNumber: 7 })).ok, true);
    await git(repo, ['checkout', '-q', 'main']);

    const prep = await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    assert.equal(prep.resumed, true);
    assert.equal(prep.branchName, 'claude/issue-7-fix-it');
    assert.match(prep.prompt, /## Resuming an interrupted run/);
    assert.match(prep.prompt, /WIP snapshot \(issue #7, agent run interrupted\)/);
    assert.match(prep.prompt, /https:\/\/github\.com\/o\/r\/pull\/3/);
    assert.match(prep.prompt, /conflicts with `main`/);
  });
});

describe('issue pipeline: interrupted work', () => {
  it('WIP-commits leftover work on the issue branch only', async () => {
    const { repo } = await cloneWithOrigin();
    const p = pipeline(issueOnly);
    assert.deepEqual(await p.commitInterruptedWork({ repo, issueNumber: 7 }), { ok: false, reason: 'clean', branch: 'main' });
    await writeFile(join(repo, 'x.txt'), 'x\n');
    assert.deepEqual(await p.commitInterruptedWork({ repo, issueNumber: 7 }), { ok: false, reason: 'not_issue_branch', branch: 'main' });
    await git(repo, ['checkout', '-q', '-b', 'claude/issue-7-fix-it']);
    const r = await p.commitInterruptedWork({ repo, issueNumber: 7 });
    assert.equal(r.ok, true);
    assert.equal(r.branch, 'claude/issue-7-fix-it');
    assert.equal(await git(repo, ['log', '-1', '--format=%s']), 'chore: WIP snapshot (issue #7, agent run interrupted)');
    assert.equal(await git(repo, ['status', '--porcelain']), '');
  });

  it('isIssueBranch does not match another issue with the same prefix digits', () => {
    const { git: g } = pipeline(issueOnly);
    assert.equal(g.isIssueBranch('claude/issue-7-fix-it', 7), true);
    assert.equal(g.isIssueBranch('claude/issue-71-other', 7), false);
  });
});

describe('issue pipeline: finish', () => {
  it('a failed agent: WIP-commits its leftovers, reports with the log path, and logs the narrative', async () => {
    const { repo } = await cloneWithOrigin();
    const p = pipeline(issueOnly);
    const prep = await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    await writeFile(join(repo, 'wip.txt'), 'partial\n');
    const logPath = join(repo, '..', `${Date.now()}-run.log`);
    await writeFile(logPath, 'agent output\n');
    const fin = await p.finish({
      repo,
      prompt: prep.prompt,
      issue: prep.issue,
      agent: { outcome: 'failed', exitCode: 1, stderr: 'boom' },
      preAgentHeadSha: prep.preAgentHeadSha,
      logPath,
      runAgent: async () => assert.fail('no autofix'),
    });
    assert.equal(fin.result, 'failed');
    assert.equal(fin.silent, false);
    assert.match(fin.message, /^⚠️ #7 — Fix it: agent exited with code 1 — needs a look\. Its leftover work is committed as WIP `[0-9a-f]+`/);
    assert.match(fin.message, new RegExp(`Log: ${logPath}$`));
    assert.equal(await git(repo, ['status', '--porcelain']), '');
    assert.match(await readFile(logPath, 'utf8'), /--- post-run report ---\nThe agent did not finish/);
  });

  it('an agent that changed nothing: a silent "no changes" message', async () => {
    const { repo } = await cloneWithOrigin();
    const p = pipeline(issueOnly);
    const prep = await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    const fin = await p.finish({
      repo,
      prompt: prep.prompt,
      issue: prep.issue,
      agent: { outcome: 'success', exitCode: 0, stderr: '' },
      preAgentHeadSha: prep.preAgentHeadSha,
      logPath: join(repo, '..', 'unused.log'),
      runAgent: async () => assert.fail('no autofix'),
    });
    assert.equal(fin.result, 'no_changes');
    assert.equal(fin.silent, true);
    assert.equal(fin.message, 'ℹ️ #7 — Fix it: the agent made no changes.');
  });

  it('full post-run: commit, push, PR, review asks for changes, one autofix, merge, issue closed, email, back to main', async () => {
    const { origin, repo } = await cloneWithOrigin();
    const PR = 'https://github.com/o/r/pull/5';
    let merged = false;
    /** @type {string[]} */
    const comments = [];
    const gh = async (args) => {
      const [a, b] = args;
      if (a === 'issue' && b === 'view') {
        const fields = args[args.indexOf('--json') + 1];
        if (fields === 'state') return JSON.stringify({ state: merged ? 'CLOSED' : 'OPEN' });
        if (fields === 'title,body,state,url') {
          return JSON.stringify({ title: 'Fix it', body: 'Make it work', state: merged ? 'CLOSED' : 'OPEN', url: 'https://github.com/o/r/issues/7' });
        }
        return ISSUE_JSON;
      }
      if (a === 'pr' && b === 'list') return '[]';
      if (a === 'pr' && b === 'create') {
        assert.ok(args.includes('--base') && args[args.indexOf('--base') + 1] === 'main');
        assert.match(args[args.indexOf('--body') + 1], /^Fixes #7/);
        return `${PR}\n`;
      }
      if (a === 'pr' && b === 'comment') {
        comments.push(await readFile(args[args.indexOf('--body-file') + 1], 'utf8'));
        return '';
      }
      if (a === 'api' && args[1] === 'repos/o/r') {
        return JSON.stringify({ allow_squash_merge: false, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: false });
      }
      if (a === 'pr' && b === 'view') return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: merged ? 'MERGED' : 'OPEN' });
      if (a === 'pr' && b === 'merge') {
        assert.ok(args.includes('--merge') && !args.includes('--auto'));
        // what GitHub does: the PR branch lands on main, and `Fixes #7` closes the issue
        await realExec('git', ['push', '-q', 'origin', 'HEAD:main'], { cwd: repo });
        merged = true;
        return '';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    /** @type {string[]} */
    const llmUrls = [];
    const fetchFn = async (url, init) => {
      llmUrls.push(url);
      const body = JSON.parse(init.body);
      const content = url.includes('deepinfra')
        ? 'We shipped the fix.'
        : (assert.match(body.messages[1].content, /\+fixed/), 'VERDICT: REQUEST_CHANGES\n\n- `fix.txt`: also handle the edge case');
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }) };
    };
    /** @type {any[]} */
    const mails = [];
    const p = pipeline(gh, { OPENAI_API_KEY: 'k', DEEPINFRA_API_KEY: 'd' }, {
      fetchFn,
      sendMail: async (subject, body) => {
        mails.push({ subject, body });
        return { ok: true, to: 'me@example.com' };
      },
    });

    const prep = await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    await writeFile(join(repo, 'fix.txt'), 'fixed\n'); // the agent's work
    /** @type {string[]} */
    const autofixPrompts = [];
    const fin = await p.finish({
      repo,
      prompt: prep.prompt,
      issue: prep.issue,
      agent: { outcome: 'success', exitCode: 0, stderr: '' },
      preAgentHeadSha: prep.preAgentHeadSha,
      logPath: join(repo, '..', `${Date.now()}-full.log`),
      runAgent: async ({ prompt, label }) => {
        assert.equal(label, 'autofix');
        autofixPrompts.push(prompt);
        await writeFile(join(repo, 'fix.txt'), 'fixed\nedge case\n');
        return { outcome: 'success', exitCode: 0, text: 'Handled it.', stderr: '' };
      },
    });

    assert.equal(fin.message, '✅ #7 merged — Fix it');
    assert.equal(fin.result, 'merged');
    assert.equal(fin.mergeNetworkError, false);
    assert.equal(autofixPrompts.length, 1);
    assert.match(autofixPrompts[0], /also handle the edge case/);
    assert.match(comments[0], /^VERDICT: REQUEST_CHANGES/);
    assert.equal(fin.post.commit?.message, 'fix: Fix it (#7)');
    assert.equal(fin.post.postReviewAutofix?.ok, true);
    assert.equal(fin.post.prAutoMergeResult?.mergedDirectly, true);
    assert.equal(fin.post.issueCloseWait?.closed, true);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /^\[.+\] Issue #7 closed: Fix it$/);
    assert.match(mails[0].body.text, /^Issue #7: Fix it\nIssue: https:\/\/github\.com\/o\/r\/issues\/7\nPull request: \S+\n\n---\n\nWe shipped the fix\.$/);
    assert.equal(llmUrls.length, 2);
    // back on an up-to-date main that has both the agent's and the autofix commit
    assert.equal(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), await git(origin, ['rev-parse', 'main']));
    assert.equal(await readFile(join(repo, 'fix.txt'), 'utf8'), 'fixed\nedge case\n');
  });

  it('an approved PR whose merge only hit network errors: says so, with the usual message', async () => {
    const { repo } = await cloneWithOrigin();
    const PR = 'https://github.com/o/r/pull/5';
    const TIMEOUT = 'Post "https://api.github.com/graphql": dial tcp 20.26.156.210:443: i/o timeout';
    const gh = async (args) => {
      const [a, b] = args;
      if (a === 'issue' && b === 'view') return args.includes('state') ? JSON.stringify({ state: 'OPEN' }) : ISSUE_JSON;
      if (a === 'pr' && b === 'list') return '[]';
      if (a === 'pr' && b === 'create') return `${PR}\n`;
      if (a === 'pr' && b === 'comment') return '';
      if (a === 'api' && args[1] === 'repos/o/r') {
        return JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: false });
      }
      if (a === 'pr' && b === 'view') return JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN' });
      if (a === 'pr' && b === 'merge') throw Object.assign(new Error('gh failed'), { stderr: TIMEOUT });
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const fetchFn = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'VERDICT: APPROVE\n\nLooks good.' } }], usage: { total_tokens: 10 } }),
    });
    const p = pipeline(gh, { OPENAI_API_KEY: 'k' }, { fetchFn });
    const prep = await p.prepare({ issueNumber: 7, alias: 'a', workspaceRoot: repo });
    await writeFile(join(repo, 'fix.txt'), 'fixed\n');
    const fin = await p.finish({
      repo,
      prompt: prep.prompt,
      issue: prep.issue,
      agent: { outcome: 'success', exitCode: 0, stderr: '' },
      preAgentHeadSha: prep.preAgentHeadSha,
      logPath: join(repo, '..', `${Date.now()}-net.log`),
      runAgent: async () => assert.fail('no autofix'),
    });
    assert.equal(fin.result, 'pr_open');
    assert.equal(fin.mergeNetworkError, true);
    assert.equal(fin.post.prAutoMergeResult?.transientNetwork, true);
    assert.match(fin.message, /^⚠️ #7 — Fix it: auto-merge was not enabled \(.*i\/o timeout\) — needs a look\.$/s);
  });
});
