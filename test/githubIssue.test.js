import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubIssues, githubCliErrorLooksTransient, ownerRepoSlugFromGithubRemote } from '../src/issuePipeline/githubIssue.js';
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
