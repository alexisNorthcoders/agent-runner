import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { describe, it } from 'node:test';
import { createIssuePipeline } from '../src/issuePipeline/index.js';
import { postRunPrLanded } from '../src/issuePipeline/postRun.js';
import { loadPipelineSettings } from '../src/issuePipeline/settings.js';
import { realGitFakeGh } from './helpers/fakeExec.js';

const execFileAsync = promisify(execFile);

/**
 * Post-run with push/PR off, no review key and fast polls; `gh` is answered by `gh(args)`.
 * @param {(args: string[]) => string} [gh]
 */
function pipeline(
  gh = () => {
    throw new Error('unexpected gh call');
  }
) {
  const exec = realGitFakeGh(gh);
  const p = createIssuePipeline({
    settings: loadPipelineSettings({
      CLAUDE_POST_RUN_PUSH: '0',
      CLAUDE_POST_RUN_PR: '0',
      CLAUDE_POST_RUN_LOG: '0',
      CLAUDE_POST_RUN_POLL_MS: '0',
      CLAUDE_POST_RUN_MAX_WAIT_MS: '40',
    }),
    exec,
    sendMail: async () => ({ ok: false, error: 'no mail in tests' }),
  });
  return Object.assign(p, { ghCalls: exec.ghCalls });
}

const noAgent = async () => {
  throw new Error('no autofix expected');
};

/** The original `maybeCommitReviewEmail` call shape, over `runPostRun`. */
const maybeCommitReviewEmail = ({ repo, userPrompt, agentRunOk, issueMode, preAgentHeadSha }, p = pipeline()) =>
  p.postRun.runPostRun({ repo, userPrompt, agentOk: agentRunOk, issueNumber: issueMode.number, preAgentHeadSha, runAgent: noAgent });

const getRepoHeadShaFull = (repo) => pipeline().git.headSha(repo);

/** @param {string} repo */
async function git(repo, args) {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return stdout.trim();
}

async function initBareRepoWithMain() {
  const repo = await mkdtemp(join(tmpdir(), 'wa-postrun-'));
  await execFileAsync('git', ['-C', repo, 'init'], { encoding: 'utf8' });
  await git(repo, ['config', 'user.email', 'test@test.local']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'README.md'), 'v0\n', 'utf8');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'init']);
  try {
    await git(repo, ['branch', '-M', 'main']);
  } catch {
    /* older git may already use master — rename if needed */
    const b = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (b === 'master') await git(repo, ['branch', '-M', 'main']);
  }
  return repo;
}

describe('reviewDiffText', () => {
  it('clean + HEAD moved: aggregates multiple commits vs base (not only git show HEAD)', async () => {
    const repo = await initBareRepoWithMain();
    await git(repo, ['checkout', '-b', 'claude/issue-35-work']);
    await writeFile(join(repo, 'a.txt'), 'a\n', 'utf8');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-m', 'add a']);
    await writeFile(join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(repo, ['add', 'b.txt']);
    await git(repo, ['commit', '-m', 'add b']);
    const pre = await git(repo, ['rev-parse', 'HEAD~2']);
    const diff = await pipeline().git.reviewDiffText(
      repo,
      { prBase: 'main', branchName: 'claude/issue-35-work' },
      { dirty: false, headMoved: true },
      pre,
      true
    );
    assert.match(diff, /a\.txt/);
    assert.match(diff, /b\.txt/);
  });

  it('dirty tree: uses working-tree / staged diff path (delegates to getDiffText)', async () => {
    const repo = await initBareRepoWithMain();
    await writeFile(join(repo, 'README.md'), 'v0\nmodified\n', 'utf8');
    const diff = await pipeline().git.reviewDiffText(
      repo,
      { prBase: 'main' },
      { dirty: true, headMoved: false },
      null,
      false
    );
    assert.match(diff, /README\.md/);
  });
});

describe('post-run git gating', () => {
  it('clean tree + unchanged HEAD: skips with clean_after_wait', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test',
      agentRunOk: true,
      issueMode: { number: 35 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, false);
    assert.equal(post.skipReason, 'clean_after_wait');
  });

  it('clean tree + unchanged HEAD but the branch has an open PR: re-reviews that PR instead of skipping', async () => {
    const repo = await initBareRepoWithMain();
    await git(repo, ['checkout', '-b', 'claude/issue-35-work']);
    await writeFile(join(repo, 'feature.txt'), 'ok\n', 'utf8');
    await git(repo, ['add', 'feature.txt']);
    await git(repo, ['commit', '-m', 'earlier run']);
    const pre = await getRepoHeadShaFull(repo);
    const PR = 'https://github.com/o/r/pull/46';
    const p = pipeline((args) =>
      args[0] === 'pr' && args[1] === 'list'
        ? JSON.stringify([{ url: PR }])
        : JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', state: 'OPEN' })
    );
    const ghCalls = p.ghCalls;
    {
      const post = await maybeCommitReviewEmail({
        repo,
        userPrompt: 'unit test',
        agentRunOk: true,
        issueMode: { number: 35 },
        preAgentHeadSha: pre,
      }, p);
      assert.notEqual(post.skipReason, 'clean_after_wait');
      assert.equal(post.ran, true);
      assert.match(post.note, /re-reviewed the open PR https:\/\/github\.com\/o\/r\/pull\/46 \(conflict\)/);
      assert.ok(ghCalls.some((a) => a.includes('--head') && a.includes('claude/issue-35-work')));
    }
  });

  it('clean tree + unchanged HEAD but the branch has commits no PR carries: picks them up instead of skipping', async () => {
    const repo = await initBareRepoWithMain();
    await git(repo, ['checkout', '-b', 'claude/issue-9-thing']);
    await writeFile(join(repo, 'feature.txt'), 'ok\n', 'utf8');
    await git(repo, ['add', 'feature.txt']);
    await git(repo, ['commit', '-m', 'run killed before push']);
    const pre = await getRepoHeadShaFull(repo);
    const p = pipeline(() => '[]');
    {
      const post = await maybeCommitReviewEmail({
        repo,
        userPrompt: 'unit test',
        agentRunOk: true,
        issueMode: { number: 9 },
        preAgentHeadSha: pre,
      }, p);
      assert.notEqual(post.skipReason, 'clean_after_wait');
      assert.equal(post.ran, true);
      assert.match(post.note, /picked up 1 commit\(s\) an earlier run left unpushed/);
    }
  });

  it('clean tree + new commit(s): runs post-run without empty_diff (uses pre…HEAD when branch tip equals base)', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    await writeFile(join(repo, 'feature.txt'), 'ok\n', 'utf8');
    await git(repo, ['add', 'feature.txt']);
    await git(repo, ['commit', '-m', 'agent commit']);
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test',
      agentRunOk: true,
      issueMode: { number: 35 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, true);
    assert.notEqual(post.skipReason, 'empty_diff');
    assert.equal(post.commit?.ok, true);
    assert.ok(post.review && post.review.length > 0);
  });

  it('dirty tree: tryCommit then proceeds (no empty_diff)', async () => {
    const repo = await initBareRepoWithMain();
    const pre = await getRepoHeadShaFull(repo);
    await writeFile(join(repo, 'wip.txt'), 'wip\n', 'utf8');
    const post = await maybeCommitReviewEmail({
      repo,
      userPrompt: 'unit test dirty',
      agentRunOk: true,
      issueMode: { number: 36 },
      preAgentHeadSha: pre,
    });
    assert.equal(post.ran, true);
    assert.notEqual(post.skipReason, 'empty_diff');
    assert.equal(post.commit?.ok, true);
    assert.ok(post.review && post.review.length > 0);
  });
});

describe('prepareForIssue resume', () => {
  it('fast-forwards the resumed issue branch to what was already pushed, so new commits push cleanly', async () => {
    const repo = await initBareRepoWithMain();
    const origin = await mkdtemp(join(tmpdir(), 'wa-origin-'));
    await execFileAsync('git', ['init', '--bare', origin], { encoding: 'utf8' });
    await git(repo, ['remote', 'add', 'origin', origin]);
    await git(repo, ['checkout', '-b', 'claude/issue-9-thing']);
    await git(repo, ['push', '-u', 'origin', 'claude/issue-9-thing']);

    // Someone else (an earlier run elsewhere, or a manual fix) pushes on top of the branch.
    const other = await mkdtemp(join(tmpdir(), 'wa-clone-'));
    await execFileAsync('git', ['clone', '-q', '-b', 'claude/issue-9-thing', origin, other], { encoding: 'utf8' });
    await git(other, ['config', 'user.email', 'test@test.local']);
    await git(other, ['config', 'user.name', 'test']);
    await writeFile(join(other, 'fix.txt'), 'fix\n', 'utf8');
    await git(other, ['add', 'fix.txt']);
    await git(other, ['commit', '-m', 'pushed fix']);
    await git(other, ['push', '-q']);
    const pushedTip = await git(other, ['rev-parse', 'HEAD']);

    const prep = await pipeline().git.prepareForIssue(repo, 9, 'thing');
    assert.equal(prep.resumed, true);
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), pushedTip);
  });
});

/**
 * Bare origin whose default branch is `defaultBranch`, cloned locally (so `origin/HEAD` is set like a
 * real clone), with the local clone sitting on a finished issue branch that was merged on origin.
 * @param {string} defaultBranch
 */
async function cloneOnMergedIssueBranch(defaultBranch) {
  const seed = await initBareRepoWithMain();
  if (defaultBranch !== 'main') await git(seed, ['branch', '-M', defaultBranch]);
  const origin = await mkdtemp(join(tmpdir(), 'wa-origin-'));
  await execFileAsync('git', ['init', '--bare', '-b', defaultBranch, origin], { encoding: 'utf8' });
  await git(seed, ['remote', 'add', 'origin', origin]);
  await git(seed, ['push', '-q', 'origin', defaultBranch]);

  const repo = await mkdtemp(join(tmpdir(), 'wa-clone-'));
  await execFileAsync('git', ['clone', '-q', origin, repo], { encoding: 'utf8' });
  await git(repo, ['config', 'user.email', 'test@test.local']);
  await git(repo, ['config', 'user.name', 'test']);
  await git(repo, ['checkout', '-b', 'claude/issue-5-thing']);
  await writeFile(join(repo, 'work.txt'), 'work\n', 'utf8');
  await git(repo, ['add', 'work.txt']);
  await git(repo, ['commit', '-m', 'work']);

  // The PR merges on GitHub: the default branch moves on origin, the local clone doesn't know yet.
  await git(seed, ['fetch', '-q', repo, 'claude/issue-5-thing']);
  await git(seed, ['merge', '-q', '--no-edit', 'FETCH_HEAD']);
  await git(seed, ['push', '-q', 'origin', defaultBranch]);
  return { repo, seed, mergedTip: await git(seed, ['rev-parse', 'HEAD']) };
}

describe('returnToDefaultBranch', () => {
  it('checks out and fast-forwards main after the issue PR merged', async () => {
    const { repo, mergedTip } = await cloneOnMergedIssueBranch('main');
    const out = await pipeline().git.returnToDefaultBranch(repo);
    assert.deepEqual(out, { ok: true, defaultBranch: 'main' });
    assert.equal(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), mergedTip);
  });

  it('uses master when that is the repo default, even if a main branch also exists', async () => {
    const { repo, seed, mergedTip } = await cloneOnMergedIssueBranch('master');
    await git(seed, ['push', '-q', 'origin', 'master:main']);
    const out = await pipeline().git.returnToDefaultBranch(repo);
    assert.deepEqual(out, { ok: true, defaultBranch: 'master' });
    assert.equal(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'master');
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), mergedTip);
  });

  it('leaves a dirty tree on the issue branch', async () => {
    const { repo } = await cloneOnMergedIssueBranch('main');
    await writeFile(join(repo, 'work.txt'), 'uncommitted\n', 'utf8');
    const out = await pipeline().git.returnToDefaultBranch(repo);
    assert.deepEqual(out, { ok: false, reason: 'dirty_tree' });
    assert.equal(await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'claude/issue-5-thing');
  });
});

describe('postRunPrLanded', () => {
  it('is true for a direct merge or a queued auto-merge whose issue closed', () => {
    assert.equal(postRunPrLanded({ prAutoMergeResult: { ok: true, mergedDirectly: true } }), true);
    assert.equal(
      postRunPrLanded({ prAutoMergeResult: { ok: true }, issueCloseWait: { closed: true } }),
      true
    );
  });

  it('is false while auto-merge is still pending, when it failed, or when it never ran', () => {
    assert.equal(
      postRunPrLanded({ prAutoMergeResult: { ok: true }, issueCloseWait: { closed: false } }),
      false
    );
    assert.equal(
      postRunPrLanded({ prAutoMergeResult: { ok: false, mergedDirectly: true } }),
      false
    );
    assert.equal(postRunPrLanded({ prAutoMergeResult: null, issueCloseWait: { closed: true } }), false);
  });
});
