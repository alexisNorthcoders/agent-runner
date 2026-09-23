import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubIssues, githubCliErrorLooksTransient, issueNumberFromAgentBranch, ownerRepoSlugFromGithubRemote } from '../src/issuePipeline/githubIssue.js';
import { loadPipelineSettings } from '../src/issuePipeline/settings.js';

describe('githubCliErrorLooksTransient', () => {
  it('detects GraphQL gateway timeout from gh', () => {
    assert.equal(githubCliErrorLooksTransient('HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)'), true);
  });

  it('detects common HTTP errors', () => {
    assert.equal(githubCliErrorLooksTransient('HTTP 502: bad gateway'), true);
    assert.equal(githubCliErrorLooksTransient('HTTP 503'), true);
    assert.equal(githubCliErrorLooksTransient('HTTP 429: rate limit'), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(githubCliErrorLooksTransient('issue 999 not found'), false);
    assert.equal(githubCliErrorLooksTransient('GraphQL: Could not resolve'), false);
  });
});

describe('ownerRepoSlugFromGithubRemote', () => {
  it('reads ssh and https GitHub remotes', () => {
    assert.equal(ownerRepoSlugFromGithubRemote('git@github.com:o/r.git\n'), 'o/r');
    assert.equal(ownerRepoSlugFromGithubRemote('https://github.com/o/r'), 'o/r');
    assert.equal(ownerRepoSlugFromGithubRemote('https://gitlab.com/o/r'), null);
  });
});

const ISSUE = { number: 7, title: 'Fix it', body: 'Steps', state: 'OPEN', url: 'https://github.com/o/r/issues/7', labels: [{ name: 'bug' }] };

/** @param {(cmd: string, args: string[]) => string} answer */
function issues(answer, env = {}) {
  /** @type {Array<[string, string[]]>} */
  const calls = [];
  const sleeps = [];
  const api = createGithubIssues({
    settings: loadPipelineSettings(env),
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: answer(cmd, args), stderr: '' };
    },
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { api, calls, sleeps };
}

describe('fetchIssuePrompt', () => {
  it('reads the issue from the repo named by origin and renders the prompt', async () => {
    const { api, calls } = issues((cmd) => (cmd === 'git' ? 'git@github.com:o/r.git\n' : JSON.stringify(ISSUE)));
    const out = await api.fetchIssuePrompt({ issueNumber: 7, workspaceRoot: '/w', alias: 'a', extraInstructions: 'add tests' });
    assert.equal(out.repo, 'o/r');
    assert.equal(out.title, 'Fix it');
    assert.match(out.markdown, /^# GitHub issue #7\n/);
    assert.match(out.markdown, /\*\*Labels:\*\* bug/);
    assert.match(out.markdown, /## Additional instructions \(from WhatsApp\)\nadd tests/);
    assert.deepEqual(calls[1][1].slice(0, 5), ['issue', 'view', '7', '--repo', 'o/r']);
  });

  it('prefers CLAUDE_ISSUE_REPO_MAP for the alias', async () => {
    const { api, calls } = issues(() => JSON.stringify(ISSUE), { CLAUDE_ISSUE_REPO_MAP: 'a=x/y' });
    assert.equal((await api.fetchIssuePrompt({ issueNumber: 7, workspaceRoot: '/w', alias: 'a' })).repo, 'x/y');
    assert.equal(calls[0][0], 'gh');
  });

  it('refuses a workspace whose repo it cannot tell', async () => {
    const { api } = issues(() => 'https://gitlab.com/o/r\n');
    await assert.rejects(api.fetchIssuePrompt({ issueNumber: 7, workspaceRoot: '/w', alias: 'a' }), /CLAUDE_ISSUE_REPO_MAP/);
  });

  it('retries a transient GitHub error, but not a permanent one', async () => {
    let n = 0;
    const flaky = issues((cmd) => {
      if (cmd === 'git') return 'git@github.com:o/r.git';
      if (++n === 1) throw Object.assign(new Error('gh failed'), { stderr: 'HTTP 504: Gateway Timeout' });
      return JSON.stringify(ISSUE);
    });
    assert.equal((await flaky.api.fetchIssuePrompt({ issueNumber: 7, workspaceRoot: '/w', alias: 'a' })).number, 7);
    assert.deepEqual(flaky.sleeps, [2500]);

    const missing = issues((cmd) => {
      if (cmd === 'git') return 'git@github.com:o/r.git';
      throw Object.assign(new Error('gh failed'), { stderr: 'GraphQL: Could not resolve to an issue' });
    });
    await assert.rejects(missing.api.fetchIssuePrompt({ issueNumber: 7, workspaceRoot: '/w', alias: 'a' }), /Could not resolve/);
    assert.deepEqual(missing.sleeps, []);
  });
});

describe('cron lookups', () => {
  it('lists open issues with their label names', async () => {
    const rows = [
      { number: 3, title: 'A', labels: [{ name: 'ready-for-agent' }] },
      { number: '4', title: 'B', labels: [] },
      { number: 0, title: 'junk' },
    ];
    const { api, calls } = issues(() => JSON.stringify(rows));
    assert.deepEqual(await api.listOpenIssues('o/r'), [
      { number: 3, title: 'A', labels: ['ready-for-agent'] },
      { number: 4, title: 'B', labels: [] },
    ]);
    assert.deepEqual(calls[0][1].slice(0, 6), ['issue', 'list', '--repo', 'o/r', '--state', 'open']);
  });

  it('reads the native blocked_by count', async () => {
    const { api, calls } = issues(() => '2\n');
    assert.equal(await api.blockedByCount('o/r', 9), 2);
    assert.deepEqual(calls[0][1], ['api', 'repos/o/r/issues/9', '--jq', '.issue_dependencies_summary.blocked_by // 0']);
  });

  it('keys open agent PRs by the issue number in their branch', async () => {
    const prs = [
      { url: 'u1', headRefName: 'claude/issue-39-lobby', headRefOid: 'h1', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
      { url: 'u2', headRefName: 'feature/x', headRefOid: 'h2', baseRefName: 'main' },
    ];
    const { api } = issues(() => JSON.stringify(prs));
    assert.deepEqual(
      await api.listOpenAgentPrsByIssue('o/r'),
      new Map([[39, { url: 'u1', headSha: 'h1', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }]])
    );
  });

  it('reads a branch tip', async () => {
    const { api, calls } = issues(() => 'abc123\n');
    assert.equal(await api.branchHeadSha('o/r', 'main'), 'abc123');
    assert.deepEqual(calls[0][1], ['api', 'repos/o/r/branches/main', '--jq', '.commit.sha']);
  });

  it('refuses a malformed repo slug', async () => {
    const { api } = issues(() => '[]');
    await assert.rejects(api.listOpenIssues('o/r --flag'), /owner\/repo/);
  });
});

describe('issueNumberFromAgentBranch', () => {
  it('reads the issue number from agent issue branches only', () => {
    assert.equal(issueNumberFromAgentBranch('claude/issue-39-lobby-ambience', 'claude/issue'), 39);
    assert.equal(issueNumberFromAgentBranch('claude/issue-7', 'claude/issue'), 7);
    assert.equal(issueNumberFromAgentBranch('claude/wa-20260101-abc', 'claude/issue'), null);
    assert.equal(issueNumberFromAgentBranch('issue/42-short', 'claude/issue'), null);
    assert.equal(issueNumberFromAgentBranch('claude/issue-x-1', 'claude/issue'), null);
  });
});
