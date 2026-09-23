import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCronTracer, partitionIssuesWithOpenPr, pickNextRunnableIssue } from '../src/cronTracer.js';
import { cronAliasesFromEnv } from '../src/config.js';
import { createCronState } from '../src/cronState.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const REPO = 'alexisNorthcoders/WhatsappBot';
const REPO_P = 'alexisNorthcoders/Platformer';
const ready = (number, title = `Task ${number}`) => ({ number, title, labels: ['ready-for-agent'] });
/** @type {(repo: string, issueNumber: number) => Promise<number>} */
const noBlockers = async () => 0;

describe('pickNextRunnableIssue', () => {
  const pick = (rows, last = new Map(), blockedByCount = noBlockers) => pickNextRunnableIssue(rows, REPO, last, blockedByCount);

  it('returns null when no issue carries the ready-for-agent label', async () => {
    assert.equal(await pick([{ number: 23, title: 'x', labels: ['needs-triage'] }, { number: 99, title: 'y', labels: [] }, { number: 9, title: 'z', labels: ['ready-for-human'] }]), null);
  });

  it('ignores case and whitespace in the label name, and a missing labels array', async () => {
    assert.equal((await pick([{ number: 1, title: 'no labels' }, { number: 2, title: 'x', labels: ['bug', ' Ready-For-Agent '] }]))?.number, 2);
  });

  it('picks the lowest ready-for-agent issue', async () => {
    assert.equal((await pick([ready(30), ready(5), ready(8)]))?.number, 5);
  });

  it("skips the repo's last-started issue rather than stalling on it", async () => {
    // e.g. its PR merged without an auto-closing "Fixes #N", so the issue is still open
    assert.equal(await pick([ready(3)], new Map([[REPO, 3]])), null);
    assert.equal((await pick([ready(77), ready(79), ready(78)], new Map([[REPO, 77]])))?.number, 78);
    assert.equal((await pick([ready(5)], new Map([[REPO, 2], ['o/other', 5]])))?.number, 5);
  });

  it('skips a blocked issue for the next one, and treats a failed lookup as blocked', async () => {
    /** @type {number[]} */
    const asked = [];
    const blocked = async (/** @type {string} */ _repo, /** @type {number} */ n) => {
      asked.push(n);
      if (n === 1) throw new Error('gh api boom');
      return n === 2 ? 1 : 0;
    };
    assert.equal((await pick([ready(1), ready(2), ready(5)], new Map(), blocked))?.number, 5);
    assert.deepEqual(asked, [1, 2, 5]);
    assert.equal(await pick([ready(2)], new Map(), blocked), null);
  });
});

describe('partitionIssuesWithOpenPr', () => {
  const pr = (url) => ({ url, headSha: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' });
  const rows = [ready(1), ready(2), ready(3)];
  const openPrs = new Map([[1, pr('u1')], [2, pr('u2')]]);
  const bases = new Map([['main', 'm']]);

  it('parks only open-PR issues whose current state was already attempted', () => {
    const attempted = new Map([[`${REPO}#1`, 'h:m'], [`${REPO}#2`, 'h:older-main']]);
    const { rows: kept, parked } = partitionIssuesWithOpenPr(rows, REPO, openPrs, bases, attempted);
    assert.deepEqual(kept.map((r) => r.number), [2, 3]);
    assert.deepEqual(parked, [{ number: 1, url: 'u1', state: 'ready', stateKey: 'h:m' }]);
  });

  it('keeps every open-PR issue that was never attempted', () => {
    const { rows: kept, parked } = partitionIssuesWithOpenPr(rows, REPO, openPrs, bases, new Map());
    assert.deepEqual(kept.map((r) => r.number), [1, 2, 3]);
    assert.deepEqual(parked, []);
  });
});

describe('cronAliasesFromEnv', () => {
  it('is the default issue alias, then the secondary ones, without repeats', () => {
    assert.deepEqual(cronAliasesFromEnv({ CLAUDE_ISSUE_DEFAULT_ALIAS: 'bot', CRON_SECONDARY_WORKSPACE_ALIASES: 'platformer, bot,snake' }), ['bot', 'platformer', 'snake']);
  });

  it('falls back to CRON_PLATFORMER_WORKSPACE_ALIAS, then "platformer"', () => {
    assert.deepEqual(cronAliasesFromEnv({ CLAUDE_ISSUE_DEFAULT_ALIAS: 'bot', CRON_PLATFORMER_WORKSPACE_ALIAS: 'plat' }), ['bot', 'plat']);
    assert.deepEqual(cronAliasesFromEnv({}), ['platformer']);
  });
});

/**
 * A tracer over fakes: `issues` maps repo → open issues, `repos` maps alias → repo. Every issue run
 * resolves with `result` (a string, or a function of the issue number) unless `startIssueRun` is
 * overridden. State is the real Redis-shaped store over the memory fake, shared across ticks.
 * @param {any} [o]
 */
function harness(o = {}) {
  const store = o.store ?? createMemoryStore();
  const state = createCronState({ store });
  const repos = o.repos ?? { bot: REPO, platformer: REPO_P };
  let issues = o.issues ?? { [REPO]: [], [REPO_P]: [] };
  let openPrs = o.openPrs ?? new Map();
  let baseSha = 'base0';
  let lockHolder = null;
  let paused = null;
  /** @type {Array<{ issueNumber: number, alias: string | null, replyTo: string, trigger?: string }>} */
  const runs = [];
  /** @type {string[]} */
  const listed = [];
  /** @type {{ replyTo: string, text: string }[]} */
  const sent = [];
  /** @type {string[]} */
  const warnings = [];
  let result = 'result' in o ? o.result : 'merged';
  const tracer = createCronTracer({
    startIssueRun:
      o.startIssueRun ??
      (async (p) => {
        runs.push(p);
        const r = typeof result === 'function' ? result(p.issueNumber) : result;
        return { reply: `Started run`, done: Promise.resolve(r) };
      }),
    lock: { current: async () => lockHolder },
    pause: { get: async () => paused },
    state,
    workspaces: {
      async resolveIssueWorkspace(alias) {
        if (!(alias in repos)) throw new Error(`Unknown workspace alias "${alias}"`);
        return { alias, root: `/repos/${alias}` };
      },
    },
    github: {
      resolveIssueRepo: async (_root, alias) => repos[alias],
      async listOpenIssues(repo) {
        listed.push(repo);
        if (o.listError) throw new Error(o.listError);
        return issues[repo] ?? [];
      },
      blockedByCount: o.blockedByCount ?? noBlockers,
      listOpenAgentPrsByIssue: async (repo) => {
        if (o.prLookupError) throw new Error(o.prLookupError);
        return openPrs.get(repo) ?? new Map();
      },
      branchHeadSha: async () => baseSha,
    },
    outbox: { send: async (m) => void sent.push(m) },
    aliases: o.aliases ?? ['bot', 'platformer'],
    intervalMs: 60_000,
    logger: { info() {}, warn: (m) => void warnings.push(String(m)) },
  });
  return {
    tracer,
    state,
    store,
    runs,
    listed,
    sent,
    warnings,
    ran: () => runs.map((r) => `${r.alias}#${r.issueNumber}`),
    setIssues: (x) => void (issues = x),
    setOpenPrs: (x) => void (openPrs = x),
    setBaseSha: (x) => void (baseSha = x),
    setResult: (x) => void (result = x),
    holdLock: (x = { runId: 'manual' }) => void (lockHolder = x),
    setPaused: (x = { reason: 'safe-restart' }) => void (paused = x),
  };
}

describe('cron tick: when to skip', () => {
  it('skips quietly while the lock is held', async () => {
    const h = harness({ issues: { [REPO]: [ready(1)] } });
    h.holdLock();
    assert.deepEqual(await h.tracer.tick(), { kind: 'busy' });
    assert.deepEqual(h.listed, []);
    assert.deepEqual(h.sent, []);
  });

  it('skips quietly while agent-runner is paused', async () => {
    const h = harness({ issues: { [REPO]: [ready(1)] } });
    h.setPaused();
    assert.deepEqual(await h.tracer.tick(), { kind: 'paused' });
    assert.deepEqual(h.listed, []);
  });

  it('counts a run refused for the lock as busy, with no message', async () => {
    const h = harness({
      issues: { [REPO]: [ready(1)] },
      startIssueRun: async () => ({ reply: 'Agent is busy.', done: null, refused: true }),
    });
    assert.deepEqual(await h.tracer.tick(), { kind: 'busy' });
    assert.deepEqual(h.sent, []);
  });

  it('is idle when no repo has a ready-for-agent issue', async () => {
    const h = harness({ issues: { [REPO]: [{ number: 1, title: 'x', labels: ['needs-triage'] }], [REPO_P]: [{ number: 2, title: 'y', labels: [] }] } });
    assert.deepEqual(await h.tracer.tick(), { kind: 'no_eligible' });
    assert.deepEqual(h.runs, []);
  });
});

describe('cron tick: picking work', () => {
  it('runs an issue through the shared pipeline, reporting to owner as a cron run', async () => {
    const h = harness({ issues: { [REPO]: [ready(7)] } });
    assert.deepEqual(await h.tracer.tick(), { kind: 'ran', repo: REPO, issue: 7, result: 'progress' });
    assert.deepEqual(h.runs, [{ issueNumber: 7, alias: 'bot', replyTo: 'owner', trigger: 'cron' }]);
  });

  it('prefers the first alias, without consulting the next', async () => {
    const h = harness({ issues: { [REPO]: [ready(50)], [REPO_P]: [ready(1)] } });
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#50']);
    assert.deepEqual(h.listed, [REPO]);
  });

  it('falls through to the next alias when the first has nothing runnable', async () => {
    const h = harness({ issues: { [REPO]: [{ number: 5, title: 'x', labels: ['needs-triage'] }], [REPO_P]: [ready(2)] } });
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['platformer#2']);
  });

  it('skips a dependency-blocked issue for the next one in the same repo first', async () => {
    const h = harness({ issues: { [REPO]: [ready(3), ready(9)], [REPO_P]: [ready(1)] }, blockedByCount: async (repo, n) => (repo === REPO && n === 3 ? 1 : 0) });
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#9']);
    assert.deepEqual(h.listed, [REPO]);
  });

  it('tries aliases in order, skipping one that does not resolve and one with no eligible issue', async () => {
    const h = harness({
      aliases: ['bot', 'gone', 'snake', 'colyseus', 'go'],
      repos: { bot: REPO, snake: 'o/snake', colyseus: 'o/colyseus', go: 'o/go' },
      issues: { [REPO]: [], 'o/snake': [], 'o/colyseus': [ready(6)], 'o/go': [ready(1)] },
    });
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['colyseus#6']);
    assert.deepEqual(h.listed, [REPO, 'o/snake', 'o/colyseus']);
    assert.match(h.warnings.join('\n'), /"gone"/);
    assert.deepEqual(h.sent, [], 'an unavailable alias is logged, not sent');
  });
});

describe('cron tick: progress', () => {
  it('after lasting progress, records last-started in Redis and does not start that issue again', async () => {
    const h = harness({ issues: { [REPO]: [ready(7)], [REPO_P]: [] }, result: 'pr_open' });
    await h.tracer.tick();
    assert.deepEqual(await h.state.lastStarted(), new Map([[REPO, 7]]));
    assert.deepEqual(await h.tracer.tick(), { kind: 'no_eligible' });
    // a restarted runner reads the same state
    const again = harness({ store: h.store, issues: { [REPO]: [ready(7)], [REPO_P]: [] } });
    await again.tracer.tick();
    assert.deepEqual(again.runs, []);
    assert.deepEqual(h.ran(), ['bot#7']);
  });

  for (const result of ['no_changes', 'failed', 'timeout', null]) {
    it(`a ${result ?? 'missing'} result is not progress, so the next tick retries the issue`, async () => {
      const h = harness({ issues: { [REPO]: [ready(32)] }, result });
      assert.deepEqual(await h.tracer.tick(), { kind: 'ran', repo: REPO, issue: 32, result: 'no_progress', note: result ?? 'no result' });
      assert.deepEqual(await h.state.lastStarted(), new Map());
      h.setResult('merged');
      await h.tracer.tick();
      assert.deepEqual(h.ran(), ['bot#32', 'bot#32']);
      assert.deepEqual(await h.state.lastStarted(), new Map([[REPO, 32]]));
    });
  }

  it('tells the owner when the issue could not be fetched or branched, and retries it later', async () => {
    const h = harness({
      issues: { [REPO]: [ready(4)] },
      startIssueRun: async () => ({ reply: 'Git setup for issue #4 failed: Working tree is not clean.', done: null }),
    });
    assert.deepEqual(await h.tracer.tick(), { kind: 'ran', repo: REPO, issue: 4, result: 'prep_failed' });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].replyTo, 'owner');
    assert.match(h.sent[0].text, /^Cron \(bot\): could not start #4 in alexisNorthcoders\/WhatsappBot: Git setup for issue #4 failed: Working tree is not clean\.$/);
    assert.deepEqual(await h.state.lastStarted(), new Map());
  });

  it('tells the owner when the run itself blew up, and does not record progress', async () => {
    const h = harness({
      issues: { [REPO]: [ready(2)] },
      startIssueRun: async () => ({ reply: 'Started', done: Promise.reject('non-Error rejection') }),
    });
    const outcome = await h.tracer.tick();
    assert.equal(outcome.kind, 'ran');
    assert.equal(outcome.result, 'failed');
    assert.match(h.sent[0].text, /Cron \(bot\): the run for alexisNorthcoders\/WhatsappBot#2 failed: non-Error rejection/);
    assert.deepEqual(await h.state.lastStarted(), new Map());
  });

  it('reports a failed lookup as a tick error to the owner', async () => {
    const h = harness({ listError: 'gh: HTTP 401' });
    const outcome = await h.tracer.tick();
    assert.equal(outcome.kind, 'error');
    assert.match(outcome.note ?? '', /listing open issues \(bot\): gh: HTTP 401/);
    assert.match(h.sent[0].text, /^Cron tick failed while listing open issues \(bot\): gh: HTTP 401/);
  });
});

describe('cron tick: open agent PRs', () => {
  const PR = 'https://github.com/alexisNorthcoders/WhatsappBot/pull/46';
  const conflicting = { url: PR, headSha: 'head1', baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };

  it('works an open-PR issue once per PR state, parks it while nothing changes, and retries when the base moves', async () => {
    const h = harness({ issues: { [REPO]: [ready(39), ready(41)], [REPO_P]: [] }, result: (n) => (n === 39 ? 'no_changes' : 'failed') });
    h.setOpenPrs(new Map([[REPO, new Map([[39, conflicting]])]]));
    h.setBaseSha('main1');
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#39'], 'a never-attempted open PR gets one go (merge the base in, re-review)');
    assert.deepEqual(await h.state.prAttempts(), new Map([[`${REPO}#39`, 'head1:main1']]), 'the state the run left the PR in is recorded');

    await h.tracer.tick();
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#39', 'bot#41', 'bot#41'], 'unchanged and still blocked: parked, the next issue runs');
    const notes = h.sent.filter((m) => m.text.includes('parking'));
    assert.equal(notes.length, 1, 'the owner hears about the parked PR once, not every tick');
    assert.equal(notes[0].replyTo, 'owner');
    assert.match(notes[0].text, /still conflicts with the default branch/);
    assert.ok(notes[0].text.includes(PR));

    // nor after a restart
    const again = harness({ store: h.store, issues: { [REPO]: [ready(39)], [REPO_P]: [] } });
    again.setOpenPrs(new Map([[REPO, new Map([[39, conflicting]])]]));
    again.setBaseSha('main1');
    await again.tracer.tick();
    assert.deepEqual(again.runs, []);
    assert.deepEqual(again.sent, []);

    h.setBaseSha('main2');
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#39', 'bot#41', 'bot#41', 'bot#39'], 'the base branch moved, so the PR gets another attempt');
  });

  it('records the state of a PR a fresh run just opened, so a blocked one is not re-run next tick', async () => {
    /** @type {ReturnType<typeof harness>} */
    let h;
    h = harness({
      issues: { [REPO]: [ready(5)] },
      startIssueRun: async (p) => {
        h.runs.push(p);
        h.setOpenPrs(new Map([[REPO, new Map([[5, { url: 'u', headSha: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }]])]]));
        return { reply: 'Started', done: Promise.resolve('no_changes') };
      },
    });
    await h.tracer.tick();
    assert.deepEqual(await h.state.prAttempts(), new Map([[`${REPO}#5`, 'h:base0']]));
  });

  it('keeps every issue eligible when the open PR lookup fails', async () => {
    const h = harness({ issues: { [REPO]: [ready(7)] }, prLookupError: 'gh down' });
    await h.tracer.tick();
    assert.deepEqual(h.ran(), ['bot#7']);
  });
});

describe('cron runOnce', () => {
  it('records each tick in Redis, and never overlaps two ticks', async () => {
    /** @type {() => void} */
    let finishRun = () => {};
    const h = harness({
      issues: { [REPO]: [ready(1)] },
      startIssueRun: async (p) => {
        h.runs.push(p);
        return { reply: 'Started', done: new Promise((r) => (finishRun = () => r('merged'))) };
      },
    });
    const first = h.tracer.runOnce();
    await new Promise((r) => setImmediate(r));
    assert.equal(await h.tracer.runOnce(), null, 'a tick while one is in flight is skipped');
    finishRun();
    await first;
    assert.equal(h.runs.length, 1);
    const saved = await h.state.read();
    assert.equal(saved?.intervalMs, 60_000);
    assert.equal(saved?.pid, process.pid);
    assert.deepEqual(saved?.outcome, { kind: 'ran', repo: REPO, issue: 1, result: 'progress' });
  });
});
