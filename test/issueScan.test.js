import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIssueScan } from '../src/issueScan.js';
import { createCronState } from '../src/cronState.js';
import { createMemoryStore } from './helpers/memoryStore.js';
import { notifyingStore } from '../src/stateChanges.js';

const REPO = 'o/bot';
const REPO_P = 'o/plat';
const issue = (number, ...labels) => ({ number, title: `Task ${number}`, labels });
const link = (repo, n) => `https://github.com/${repo}/issues/${n}`;
const pr = (url, headSha = 'h') => ({ url, headSha, baseRefName: 'main', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' });

/**
 * A `gh` fake per repo: its open issues, open agent PRs (by issue), blockers per issue (a number,
 * or an Error to throw), and the tip of `main`. `fail` makes every call for the repo throw.
 * @param {Record<string, { issues?: any[], prs?: Map<number, any>, blockers?: Record<number, number | Error>, fail?: boolean }>} repos
 */
function fakeGithub(repos) {
  /** @type {string[]} */
  const calls = [];
  const of = (repo) => {
    const r = repos[repo];
    if (!r || r.fail) throw new Error(`gh: could not reach ${repo}`);
    return r;
  };
  return {
    calls,
    resolveIssueRepo: async (_root, alias) => ({ bot: REPO, plat: REPO_P })[alias],
    listOpenIssues: async (repo) => {
      calls.push(`issues ${repo}`);
      return of(repo).issues ?? [];
    },
    listOpenAgentPrsByIssue: async (repo) => of(repo).prs ?? new Map(),
    branchHeadSha: async () => 'm',
    blockedByCount: async (repo, n) => {
      calls.push(`blockers ${repo}#${n}`);
      const b = of(repo).blockers?.[n] ?? 0;
      if (b instanceof Error) throw b;
      return b;
    },
  };
}

const workspaces = (aliases = ['bot', 'plat']) => ({
  aliases: async () => aliases,
  resolveIssueWorkspace: async (alias) => ({ alias, root: `/ws/${alias}` }),
});

/** @param {{ github: any, aliases?: string[], store?: any, now?: () => number }} p */
function setup({ github, aliases, store = createMemoryStore(), now = () => Date.parse('2026-09-26T10:00:00Z') }) {
  const cronState = createCronState({ store });
  /** @type {string[]} */
  const changes = [];
  const scan = createIssueScan({
    workspaces: workspaces(aliases),
    github,
    prAttempts: cronState.prAttempts,
    intervalMs: 300_000,
    now,
    onChange: (r) => changes.push(r),
    logger: { warn() {}, info() {} },
  });
  return { scan, cronState, store, changes };
}

describe('issue scan', () => {
  it('is null before the first scan', () => {
    const { scan } = setup({ github: fakeGithub({}) });
    assert.equal(scan.current(), null);
  });

  it('lists each workspace repo: runnable, blocked and parked ready-for-agent issues, ready-for-human, and triage counts', async () => {
    const github = fakeGithub({
      [REPO]: {
        issues: [
          issue(9, 'ready-for-agent'),
          issue(3, ' Ready-For-Agent '),
          issue(4, 'ready-for-agent'),
          issue(5, 'ready-for-agent'),
          issue(6, 'ready-for-human'),
          issue(7, 'needs-triage'),
          issue(8, 'needs-triage', 'bug'),
          issue(10, 'needs-info'),
          issue(11),
        ],
        blockers: { 4: 2, 9: new Error('gh api boom') },
        prs: new Map([[5, pr('https://github.com/o/bot/pull/50')]]),
      },
      [REPO_P]: { issues: [issue(1, 'ready-for-human')] },
    });
    const { scan, cronState, changes } = setup({ github });
    // the cron already worked PR 50 in this state, so the issue is parked
    await cronState.setPrAttempt(REPO, 5, 'h:m');
    await scan.scan();
    const got = scan.current();
    assert.equal(got?.scannedAt, '2026-09-26T10:00:00.000Z');
    assert.deepEqual(got?.repos, [
      {
        alias: 'bot',
        repo: REPO,
        scannedAt: '2026-09-26T10:00:00.000Z',
        stale: false,
        runnable: [{ number: 3, title: 'Task 3', url: link(REPO, 3) }],
        // a failed blocker lookup counts as blocked, as it does for the cron
        blocked: [
          { number: 4, title: 'Task 4', url: link(REPO, 4) },
          { number: 9, title: 'Task 9', url: link(REPO, 9) },
        ],
        parked: [{ number: 5, title: 'Task 5', url: link(REPO, 5), prUrl: 'https://github.com/o/bot/pull/50' }],
        readyForHuman: [{ number: 6, title: 'Task 6', url: link(REPO, 6) }],
        needsTriage: 2,
        needsInfo: 1,
      },
      {
        alias: 'plat',
        repo: REPO_P,
        scannedAt: '2026-09-26T10:00:00.000Z',
        stale: false,
        runnable: [],
        blocked: [],
        parked: [],
        readyForHuman: [{ number: 1, title: 'Task 1', url: link(REPO_P, 1) }],
        needsTriage: 0,
        needsInfo: 0,
      },
    ]);
    assert.deepEqual(changes, ['issue-scan']);
  });

  it('keeps an open-PR issue runnable while its PR state has not been attempted, as the cron does', async () => {
    const github = fakeGithub({ [REPO]: { issues: [issue(5, 'ready-for-agent')], prs: new Map([[5, pr('u', 'newer')]]) } });
    const { scan, cronState } = setup({ github, aliases: ['bot'] });
    await cronState.setPrAttempt(REPO, 5, 'h:m');
    await scan.scan();
    assert.deepEqual(scan.current()?.repos[0].runnable.map((i) => i.number), [5]);
    assert.deepEqual(scan.current()?.repos[0].parked, []);
  });

  it("doesn't change any cron state", async () => {
    const github = fakeGithub({ [REPO]: { issues: [issue(5, 'ready-for-agent'), issue(6, 'ready-for-agent')], prs: new Map([[5, pr('u')]]) } });
    /** @type {string[]} */
    const writes = [];
    const { scan, cronState } = setup({ github, aliases: ['bot'], store: notifyingStore(createMemoryStore(), (key) => void writes.push(key)) });
    await cronState.setPrAttempt(REPO, 5, 'h:m');
    writes.length = 0;
    await scan.scan();
    assert.deepEqual(scan.current()?.repos[0].parked.map((i) => i.number), [5]);
    assert.deepEqual(writes, []);
  });

  it('keeps the last good data of a repo whose scan fails, marked stale', async () => {
    let t = Date.parse('2026-09-26T10:00:00Z');
    const repos = { [REPO]: { issues: [issue(3, 'ready-for-agent')] }, [REPO_P]: { issues: [issue(1, 'ready-for-human')] } };
    const { scan } = setup({ github: fakeGithub(repos), now: () => t });
    await scan.scan();
    repos[REPO].fail = true;
    t += 300_000;
    await scan.scan();
    const [bot, plat] = scan.current()?.repos ?? [];
    assert.equal(scan.current()?.scannedAt, '2026-09-26T10:05:00.000Z');
    assert.equal(bot.stale, true);
    assert.equal(bot.scannedAt, '2026-09-26T10:00:00.000Z');
    assert.deepEqual(bot.runnable.map((i) => i.number), [3]);
    assert.equal(plat.stale, false);
    assert.equal(plat.scannedAt, '2026-09-26T10:05:00.000Z');
    // and it recovers on the next good scan
    repos[REPO].fail = false;
    await scan.scan();
    assert.equal(scan.current()?.repos[0].stale, false);
  });

  it('shows a repo that has never scanned as stale with nothing in it', async () => {
    const { scan } = setup({ github: fakeGithub({ [REPO]: { fail: true } }), aliases: ['bot'] });
    await scan.scan();
    assert.deepEqual(scan.current()?.repos, [
      { alias: 'bot', repo: null, scannedAt: null, stale: true, runnable: [], blocked: [], parked: [], readyForHuman: [], needsTriage: 0, needsInfo: 0 },
    ]);
  });

  it('marks everything stale when the workspace list cannot be read', async () => {
    const github = fakeGithub({ [REPO]: { issues: [issue(3, 'ready-for-agent')] } });
    let broken = false;
    const scan = createIssueScan({
      workspaces: {
        aliases: async () => {
          if (broken) throw new Error('bad map file');
          return ['bot'];
        },
        resolveIssueWorkspace: async (alias) => ({ alias, root: `/ws/${alias}` }),
      },
      github,
      prAttempts: async () => new Map(),
      intervalMs: 300_000,
      logger: { warn() {}, info() {} },
    });
    await scan.scan();
    broken = true;
    await scan.scan();
    assert.equal(scan.current()?.repos[0].stale, true);
    assert.deepEqual(scan.current()?.repos[0].runnable.map((i) => i.number), [3]);
  });

  it('a PR lookup that fails makes the repo stale rather than guessing what is parked', async () => {
    const github = fakeGithub({ [REPO]: { issues: [issue(3, 'ready-for-agent')] } });
    github.listOpenAgentPrsByIssue = async () => {
      throw new Error('gh pr list boom');
    };
    const { scan } = setup({ github, aliases: ['bot'] });
    await scan.scan();
    assert.equal(scan.current()?.repos[0].stale, true);
  });

  it('runs one scan at a time, and a scan asked for meanwhile runs once after it', async () => {
    const github = fakeGithub({ [REPO]: { issues: [] } });
    /** @type {(() => void)[]} */
    const gates = [];
    const list = github.listOpenIssues;
    github.listOpenIssues = async (repo) => {
      await new Promise((r) => gates.push(() => r(undefined)));
      return list(repo);
    };
    const { scan } = setup({ github, aliases: ['bot'] });
    const first = scan.scan();
    const second = scan.scan();
    scan.scan();
    await new Promise((r) => setImmediate(r));
    assert.equal(gates.length, 1);
    gates.shift()?.();
    await new Promise((r) => setImmediate(r));
    // the one rescan asked for while the first ran
    assert.equal(gates.length, 1);
    gates.shift()?.();
    await Promise.all([first, second]);
    assert.deepEqual(github.calls, ['issues o/bot', 'issues o/bot']);
  });
});
