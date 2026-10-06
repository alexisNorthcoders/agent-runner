import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_INSIGHT_CURSOR_KEY,
  REPO_INSIGHT_PRIORITY as ORDER,
  createRepoInsightCursor,
  pickNextIdleWorkspace as pick,
} from '../src/repoInsight.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const allIdle = Object.fromEntries(ORDER.map((a) => [a, true]));
const only = (...aliases) => Object.fromEntries(ORDER.map((a) => [a, aliases.includes(a)]));

describe('pickNextIdleWorkspace', () => {
  it('has the fixed 12-workspace order', () => {
    assert.equal(ORDER.length, 12);
    assert.equal(ORDER[0], 'bot');
    assert.equal(ORDER[11], 'dots');
  });

  it('starts at the top without a cursor', () => {
    assert.equal(pick(ORDER, allIdle, null), 'bot');
  });

  it('picks the workspace just after the cursor, wherever it sits', () => {
    ORDER.slice(0, -1).forEach((alias, i) => assert.equal(pick(ORDER, allIdle, alias), ORDER[i + 1]));
  });

  it('wraps from the last entry to the first', () => {
    assert.equal(pick(ORDER, allIdle, 'dots'), 'bot');
  });

  it('skips non-idle workspaces', () => {
    assert.equal(pick(ORDER, only('go-server', 'dots'), 'agent-runner'), 'go-server');
  });

  it('wraps past the end while skipping', () => {
    assert.equal(pick(ORDER, only('chess-trainer'), 'platformer'), 'chess-trainer');
  });

  it('picks the cursor itself when it is the only idle workspace', () => {
    assert.equal(pick(ORDER, only('snake-lab'), 'snake-lab'), 'snake-lab');
  });

  it('returns null when nothing is idle', () => {
    assert.equal(pick(ORDER, only(), 'bot'), null);
    assert.equal(pick(ORDER, {}, null), null);
  });

  it('treats an unknown cursor as no cursor, and accepts a Map', () => {
    assert.equal(pick(ORDER, allIdle, 'gone'), 'bot');
    assert.equal(pick(ORDER, new Map([['dots', true]]), 'bot'), 'dots');
  });
});

describe('repo insight cursor', () => {
  it('is null until written', async () => {
    assert.equal(await createRepoInsightCursor({ store: createMemoryStore() }).read(), null);
  });

  it('round-trips the alias under its own key', async () => {
    const store = createMemoryStore();
    const cursor = createRepoInsightCursor({ store });
    await cursor.write('platformer');
    assert.equal(await cursor.read(), 'platformer');
    assert.equal(await store.get(REPO_INSIGHT_CURSOR_KEY), 'platformer');
    await cursor.write('dots');
    assert.equal(await cursor.read(), 'dots');
  });

  it('refuses an empty alias', async () => {
    await assert.rejects(createRepoInsightCursor({ store: createMemoryStore() }).write(''), TypeError);
  });
});

describe('repo insight lookups', () => {
  const issue = (number, ...labels) => ({ number, title: `T${number}`, labels });
  const suggested = /** @type {import('../src/issuePipeline/githubIssue.js').SuggestedIssue[]} */ ([{ number: 9, title: 'S', url: 'u', state: 'closed', labels: ['agent-suggested', 'wontfix'] }]);
  const setup = async ({ issues = [], blockers = {}, prs = new Map(), attempts = new Map() } = {}) => {
    const { createRepoInsightLookups } = await import('../src/repoInsight.js');
    return createRepoInsightLookups({
      workspaces: { resolveIssueWorkspace: async (alias) => ({ alias, root: `/ws/${alias}` }) },
      github: {
        resolveIssueRepo: async (_root, alias) => `o/${alias}`,
        listOpenIssues: async () => issues,
        listOpenAgentPrsByIssue: async () => prs,
        branchHeadSha: async () => 'm',
        blockedByCount: async (_r, n) => {
          const b = blockers[n] ?? 0;
          if (b instanceof Error) throw b;
          return b;
        },
        listAgentSuggestedIssues: async (repo) => (repo === 'o/bot' ? suggested : []),
      },
      prAttempts: async () => attempts,
    });
  };

  it('is idle with no ready-for-agent issues', async () => {
    assert.equal(await (await setup({ issues: [issue(1, 'ready-for-human'), issue(2)] })).isIdle('bot'), true);
  });

  it('is busy with a runnable issue', async () => {
    assert.equal(await (await setup({ issues: [issue(1, 'ready-for-agent')] })).isIdle('bot'), false);
  });

  it('stays idle when every ready issue is blocked, or its blocker lookup fails', async () => {
    const l = await setup({ issues: [issue(1, 'ready-for-agent'), issue(2, 'ready-for-agent')], blockers: { 1: 1, 2: new Error('gh') } });
    assert.equal(await l.isIdle('bot'), true);
  });

  it('stays idle when the only ready issue is parked behind an attempted open PR', async () => {
    const pr = { url: 'p', headSha: 'h', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const { prAttemptStateKey } = await import('../src/cronState.js');
    const attempts = new Map([['o/bot#1', prAttemptStateKey(pr, 'm')]]);
    const l = await setup({ issues: [issue(1, 'ready-for-agent')], prs: new Map([[1, pr]]), attempts });
    assert.equal(await l.isIdle('bot'), true);
    // an unattempted PR state keeps it runnable
    assert.equal(await (await setup({ issues: [issue(1, 'ready-for-agent')], prs: new Map([[1, pr]]) })).isIdle('bot'), false);
  });

  it('returns the past agent-suggested issues of the alias repo', async () => {
    const l = await setup();
    assert.deepEqual(await l.pastSuggestions('bot'), suggested);
    assert.deepEqual(await l.pastSuggestions('dots'), []);
  });
});
