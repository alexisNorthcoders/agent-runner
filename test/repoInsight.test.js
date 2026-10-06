import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_INSIGHT_CURSOR_KEY,
  REPO_INSIGHT_PRIORITY as ORDER,
  createRepoInsightCursor,
  decideRepoInsightTarget as decide,
  pickNextIdleWorkspace as pick,
  runRepoInsight,
  sweepRepoInsight,
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

describe('decideRepoInsightTarget', () => {
  /** @returns {any} */
  const fakes = ({ cursor = null, idle = [], past = {} } = {}) => {
    const calls = [];
    return {
      calls,
      deps: {
        order: ['a', 'b', 'c'],
        cursor: { read: async () => cursor, write: async (alias) => calls.push(`write:${alias}`) },
        isIdle: async (alias) => (calls.push(`idle:${alias}`), idle.includes(alias)),
        pastSuggestions: async (alias) => (calls.push(`past:${alias}`), past[alias] ?? []),
      },
    };
  };

  it('checks from just after the cursor, wrapping, and stops at the first idle one', async () => {
    const { calls, deps } = fakes({ cursor: 'b', idle: ['a', 'c'] });
    const r = await decide(deps);
    assert.equal(r.alias, 'c');
    assert.deepEqual(calls, ['idle:c', 'write:c', 'past:c']);
  });

  it('wraps around the end', async () => {
    const { calls, deps } = fakes({ cursor: 'b', idle: ['a'] });
    assert.equal((await decide(deps)).alias, 'a');
    assert.deepEqual(calls.slice(0, 3), ['idle:c', 'idle:a', 'write:a']);
  });

  it('persists the cursor before fetching past suggestions, even if that fails', async () => {
    const { calls, deps } = fakes({ idle: ['b'] });
    deps.pastSuggestions = async () => { throw new Error('gh down'); };
    await assert.rejects(decide(deps), /gh down/);
    assert.deepEqual(calls, ['idle:a', 'idle:b', 'write:b']);
  });

  it('returns the past suggestions alongside the alias', async () => {
    const { deps } = fakes({ idle: ['a'], past: { a: [3] } });
    assert.deepEqual(await decide(deps), { alias: 'a', pastSuggestions: [3] });
  });

  it('leaves the cursor alone and returns null when nothing is idle', async () => {
    const { calls, deps } = fakes({ cursor: 'a' });
    assert.equal(await decide(deps), null);
    assert.deepEqual(calls, ['idle:b', 'idle:c', 'idle:a']);
  });
});

describe('runRepoInsight', () => {
  /** @type {import('../src/issuePipeline/githubIssue.js').SuggestedIssue[]} */
  const past = [
    { number: 3, title: 'Cache the thing', url: 'u3', state: 'open', labels: ['agent-suggested'] },
    { number: 4, title: 'Drop the widget', url: 'u4', state: 'closed', labels: ['agent-suggested'] },
  ];
  const setup = (text = '{"title":"Add retries","body":"Why and how"}') => {
    const calls = { session: [], issues: [] };
    return {
      calls,
      deps: {
        target: { alias: 'bot', pastSuggestions: past },
        resolveWorkspace: async (alias) => ({ root: `/ws/${alias}` }),
        resolveRepo: async (root, alias) => `me/${alias}-repo`,
        launchSession: async (p) => (calls.session.push(p), { text }),
        createIssue: async (repo, p) => (calls.issues.push([repo, p]), { number: 9, url: 'https://github.com/me/bot-repo/issues/9', title: p.title }),
      },
    };
  };

  it('explores the workspace with the past suggestions in the prompt', async () => {
    const { calls, deps } = setup();
    await runRepoInsight(deps);
    assert.equal(calls.session.length, 1);
    assert.equal(calls.session[0].cwd, '/ws/bot');
    assert.match(calls.session[0].prompt, /#3 \[open\] Cache the thing/);
    assert.match(calls.session[0].prompt, /#4 \[closed\] Drop the widget/);
  });

  it('files exactly one issue with both labels and reports it', async () => {
    const { calls, deps } = setup('Here you go:\n```json\n{"title":"Add retries","body":"Why and how"}\n```');
    const line = await runRepoInsight(deps);
    assert.deepEqual(calls.issues, [['me/bot-repo', { title: 'Add retries', body: 'Why and how', labels: ['agent-suggested', 'needs-triage'] }]]);
    assert.match(line, /bot/);
    assert.match(line, /#9/);
    assert.match(line, /Add retries/);
  });

  it('with no target prints the outcome and starts nothing', async () => {
    const { calls, deps } = setup();
    const line = await runRepoInsight({ ...deps, target: null });
    assert.match(line, /nothing idle/);
    assert.equal(calls.session.length, 0);
    assert.equal(calls.issues.length, 0);
  });

  it('files nothing when the session returns no usable idea', async () => {
    const { calls, deps } = setup('I could not decide.');
    await assert.rejects(runRepoInsight(deps), /no usable/);
    assert.equal(calls.issues.length, 0);
  });
});

describe('sweepRepoInsight', () => {
  const setup = (idleAliases, { failOn } = /** @type {{ failOn?: string }} */ ({})) => {
    const store = createMemoryStore();
    const cursor = createRepoInsightCursor({ store });
    const explored = [];
    const checked = [];
    const deps = {
      cursor,
      isIdle: async (a) => {
        checked.push(a);
        if (a === failOn) throw new Error('boom');
        return idleAliases.includes(a);
      },
      pastSuggestions: async () => [],
      explore: async ({ alias }) => {
        explored.push(alias);
        return `filed in ${alias}`;
      },
    };
    return { deps, cursor, explored, checked };
  };

  it('checks every workspace in order, ignoring the cursor, and explores only the idle ones', async () => {
    const { deps, cursor, explored, checked } = setup(['chess-trainer', 'dots']);
    await cursor.write('platformer');
    const { lines } = await sweepRepoInsight(deps);
    assert.deepEqual(checked, ORDER);
    assert.deepEqual(explored, ['chess-trainer', 'dots']);
    assert.ok(lines.includes('repo-insight: bot → not idle, skipped'));
  });

  it('leaves the cursor on the last workspace even when it is not idle', async () => {
    const { deps, cursor } = setup(['bot']);
    await sweepRepoInsight(deps);
    assert.equal(await cursor.read(), 'dots');
  });

  it('starts no session when nothing is idle', async () => {
    const { deps, explored, cursor } = setup([]);
    const { failed } = await sweepRepoInsight(deps);
    assert.deepEqual(explored, []);
    assert.equal(failed, 0);
    assert.equal(await cursor.read(), 'dots');
  });

  it('reports a failing workspace and carries on', async () => {
    const { deps, explored, cursor } = setup(['bot', 'dots'], { failOn: 'bot' });
    const { lines, failed } = await sweepRepoInsight(deps);
    assert.equal(failed, 1);
    assert.deepEqual(explored, ['dots']);
    assert.ok(lines.some((l) => l.includes('bot → failed (boom)')));
    assert.equal(await cursor.read(), 'dots');
  });

  it('a second sweep re-checks everything; de-duplication is the explore step\'s job', async () => {
    const { deps, explored } = setup(['bot']);
    await sweepRepoInsight(deps);
    await sweepRepoInsight(deps);
    assert.deepEqual(explored, ['bot', 'bot']);
  });
});
