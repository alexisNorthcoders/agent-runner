import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';
import { createRunLock } from '../src/runLock.js';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createOutbox, OUTBOX_KEY } from '../src/outbox.js';
import { createMemoryStore } from './helpers/memoryStore.js';

/** Controllable AgentBackend fake: each start() creates a run you settle by hand. */
function fakeBackend() {
  /** @type {any[]} */
  const starts = [];
  return {
    starts,
    backend: {
      name: 'fake',
      async start(opts) {
        /** @type {(r: any) => void} */
        let settle = () => {};
        const done = new Promise((r) => (settle = r));
        const run = {
          opts,
          stopped: false,
          pid: 900 + starts.length,
          done,
          stop() {
            run.stopped = true;
            settle(result('stopped', 'partial'));
          },
          finish: (outcome = 'success', text = 'All done') => settle(result(outcome, text)),
        };
        starts.push(run);
        return run;
      },
    },
  };
}

const result = (outcome, text) => ({
  outcome,
  exitCode: outcome === 'success' ? 0 : outcome === 'failed' ? 1 : null,
  text,
  stderr: outcome === 'failed' ? 'boom' : '',
  logPath: '/logs/x.log',
  usage: { model: 'm', sessionId: null, turns: 3, costUsd: 0.12, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreate: 0 } },
});

function setup(overrides = {}) {
  const store = createMemoryStore();
  const lock = createRunLock({ store, ttlSeconds: 60 });
  const pause = createPauseFlag({ store });
  const outbox = createOutbox({ store });
  const { backend, starts } = fakeBackend();
  /** @type {any[]} */
  const history = [];
  /** @type {string[]} */
  const restarts = [];
  /** @type {{ record: any, progress: any[], finished: boolean }[]} */
  const tracked = [];
  const activeRuns = {
    track(record) {
      const t = { record, progress: [], finished: false };
      tracked.push(t);
      return {
        ready: Promise.resolve(),
        update: async (p) => void t.progress.push(p),
        finish: async () => void (t.finished = true),
      };
    },
  };
  let snapshot = {
    now: Date.parse('2026-09-24T12:00:00Z'),
    active: [],
    paused: null,
    cron: null,
    cronAlive: false,
    history: [],
  };
  let clock = Date.parse('2026-09-24T12:00:00Z');
  let n = 0;
  const runner = createRunner({
    lock,
    pause,
    outbox,
    backend,
    history: {
      append: async (e) => void history.push(e),
      read: async ({ limit = Infinity } = {}) => [...history].reverse().slice(0, limit),
    },
    activeRuns,
    statusSnapshot: async () => snapshot,
    joplin: {
      getNote: async (q) => {
        if (q === 'missing') throw new Error('No note matching "missing"');
        if (q === 'empty') return { id: 'e1', title: 'Empty', body: '  ' };
        return { id: 'abc123', title: 'Plan', body: 'note instructions' };
      },
    },
    launchSafeRestart: (replyTo) => void restarts.push(replyTo),
    workspaceRoot: '/home/u/Projects',
    logsDir: '/runner/logs/agent-runs',
    preamble: 'PREAMBLE',
    newRunId: () => `run-${++n}`,
    now: () => clock,
    logger: { error() {}, warn() {}, info() {} },
    ...overrides,
  });
  const outboxEntries = () => (store.streams.get(OUTBOX_KEY) ?? []).map((e) => e.fields);
  return {
    store,
    lock,
    pause,
    runner,
    starts,
    history,
    restarts,
    tracked,
    outboxEntries,
    /** @param {number} ms */
    advance: (ms) => void (clock += ms),
    /** @param {object} s */
    setSnapshot: (s) => void (snapshot = { ...snapshot, ...s }),
  };
}

describe('runner: freeform runs', () => {
  it('starts the agent in the workspace, replies "started", and posts the result to the outbox', async () => {
    const { runner, starts, lock, history, outboxEntries } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude list the repos', replyTo: 'jid-1' });
    assert.match(reply, /Started run run-1/);
    assert.equal(starts.length, 1);
    assert.deepEqual(
      { ...starts[0].opts, onProgress: undefined },
      { prompt: 'list the repos', preamble: 'PREAMBLE', cwd: '/home/u/Projects', logPath: '/runner/logs/agent-runs/run-1.log', onProgress: undefined }
    );
    assert.equal((await lock.current())?.agentPid, 900);

    starts[0].finish('success', 'Here are the repos');
    await runner.idle();
    const [msg] = outboxEntries();
    assert.equal(msg.replyTo, 'jid-1');
    assert.equal(msg.runId, 'run-1');
    assert.match(msg.text, /Here are the repos/);
    assert.equal(await lock.current(), null);
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'success');
    assert.equal(history[0].runId, 'run-1');
  });

  it('rejects a second request while busy, without starting anything', async () => {
    const { runner, starts } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude two', replyTo: 'b' });
    assert.match(reply, /busy/i);
    assert.match(reply, /run-1/);
    assert.equal(starts.length, 1);
  });

  it('reports a failed run with the error and log path', async () => {
    const { runner, starts, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    starts[0].finish('failed', '');
    await runner.idle();
    const [msg] = outboxEntries();
    assert.match(msg.text, /failed/);
    assert.match(msg.text, /boom/);
    assert.match(msg.text, /\/logs\/x\.log/);
  });

  it('refuses to start while paused', async () => {
    const { runner, pause, starts } = setup();
    await pause.set('safe-restart');
    const { reply } = await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    assert.match(reply, /paused/);
    assert.equal(starts.length, 0);
  });

  it('backs off if safe-restart paused between the pause check and taking the lock', async () => {
    const { runner, pause, lock, starts } = setup();
    const realGet = pause.get;
    let calls = 0;
    pause.get = async () => (++calls === 1 ? null : realGet());
    await pause.set('safe-restart');
    const { reply } = await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    assert.match(reply, /paused/);
    assert.equal(starts.length, 0);
    assert.equal(await lock.current(), null);
  });

  it('releases the lock and says so if the backend fails to start', async () => {
    const { runner, lock } = setup({
      backend: { name: 'broken', start: async () => { throw new Error('EACCES logs'); } },
    });
    const { reply } = await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    assert.match(reply, /Could not start.*EACCES logs/s);
    assert.equal(await lock.current(), null);
  });

  it('still releases the lock when the outbox write fails', async () => {
    const { runner, starts, lock, store } = setup();
    await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    const realAppend = store.appendToStream;
    store.appendToStream = async () => {
      throw new Error('redis down');
    };
    starts[0].finish();
    await runner.idle();
    store.appendToStream = realAppend;
    assert.equal(await lock.current(), null);
  });

  it('returns parse errors as the reply', async () => {
    const { runner } = setup();
    assert.match((await runner.handleCommand({ text: 'claude', replyTo: 'a' })).reply, /Usage/);
  });
});

describe('runner: joplin', () => {
  it('uses the note body as the prompt', async () => {
    const { runner, starts } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude joplin:Plan', replyTo: 'a' });
    assert.match(reply, /Joplin note "Plan"/);
    assert.equal(starts[0].opts.prompt, 'note instructions');
  });

  it('replies with the Joplin error and frees the lock', async () => {
    const { runner, starts, lock } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude joplin:missing', replyTo: 'a' });
    assert.match(reply, /Joplin.*No note matching/s);
    assert.equal(starts.length, 0);
    assert.equal(await lock.current(), null);
  });

  it('refuses an empty note', async () => {
    const { runner, starts, lock } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude joplin:empty', replyTo: 'a' });
    assert.match(reply, /empty/);
    assert.equal(starts.length, 0);
    assert.equal(await lock.current(), null);
  });
});

describe('runner: claude:stop', () => {
  it('kills the active run; a follow-up lands in the outbox and the lock is freed', async () => {
    const { runner, starts, lock, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude long job', replyTo: 'jid-1' });
    const { reply } = await runner.handleCommand({ text: 'claude:stop', replyTo: 'jid-2' });
    assert.match(reply, /Stopping run run-1/);
    assert.equal(starts[0].stopped, true);
    await runner.idle();
    const [msg] = outboxEntries();
    assert.equal(msg.replyTo, 'jid-1');
    assert.match(msg.text, /stopped/);
    assert.equal(await lock.current(), null);
  });

  it('says nothing is running when idle', async () => {
    const { runner } = setup();
    assert.match((await runner.handleCommand({ text: 'claude:stop', replyTo: 'a' })).reply, /Nothing is running/);
  });
});

describe('runner: claude:restart', () => {
  it('launches safe-restart when idle, passing replyTo', async () => {
    const { runner, restarts } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude:restart', replyTo: 'jid-9' });
    assert.match(reply, /Restarting/);
    assert.deepEqual(restarts, ['jid-9']);
  });

  it('refuses while a run is active', async () => {
    const { runner, restarts } = setup();
    await runner.handleCommand({ text: 'claude job', replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude:restart', replyTo: 'b' });
    assert.match(reply, /refused.*run-1/s);
    assert.deepEqual(restarts, []);
  });
});

describe('runner: status', () => {
  it('reports idle, then the active run with live progress', async () => {
    const { runner, starts, pause } = setup();
    assert.deepEqual(await runner.status(), { busy: false, activeRun: null, paused: false });
    await runner.handleCommand({ text: 'claude job', replyTo: 'a' });
    starts[0].opts.onProgress({ model: 'm', turns: 2, outputTokens: 5, contextTokens: 9, lastActivity: 'Bash: ls' });
    const s = await runner.status();
    assert.equal(s.busy, true);
    assert.equal(s.activeRun.runId, 'run-1');
    assert.equal(s.activeRun.lastActivity, 'Bash: ls');
    assert.equal(s.activeRun.replyTo, 'a');
    await pause.set('x');
    assert.equal((await runner.status()).paused, true);
  });
});

describe('runner: active-run files', () => {
  it('tracks a run from start to finish, with its progress and duration in history', async () => {
    const { runner, starts, tracked, history, advance } = setup();
    await runner.handleCommand({ text: 'claude job', replyTo: 'a' });
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0].record.runId, 'run-1');
    assert.equal(tracked[0].record.agentPid, 900);
    const p = { model: 'm', turns: 2, outputTokens: 5, contextTokens: 9, lastActivity: 'Bash: ls' };
    starts[0].opts.onProgress(p);
    assert.deepEqual(tracked[0].progress, [p]);
    advance(90_000);
    starts[0].finish();
    await runner.idle();
    assert.equal(tracked[0].finished, true);
    assert.equal(history[0].durationMs, 90_000);
  });

  it('does not publish anything for a request that never started a run', async () => {
    const { runner, tracked, pause } = setup();
    await pause.set('x');
    await runner.handleCommand({ text: 'claude job', replyTo: 'a' });
    await runner.handleCommand({ text: 'claude joplin:missing', replyTo: 'a' });
    assert.equal(tracked.length, 0);
  });
});

describe('runner: claude:status and claude:history', () => {
  it('replies with the compact status text', async () => {
    const { runner, setSnapshot } = setup();
    setSnapshot({ paused: { token: 't', reason: 'safe-restart', pausedAt: null } });
    const { reply } = await runner.handleCommand({ text: 'claude:status', replyTo: 'a' });
    assert.match(reply, /^Agent: idle$/m);
    assert.match(reply, /^Paused: yes \(safe-restart\)$/m);
    assert.match(reply, /^Cron: /m);
  });

  it('lists the last n finished runs with cost and tokens', async () => {
    const { runner, starts } = setup();
    for (const job of ['one', 'two', 'three']) {
      await runner.handleCommand({ text: `claude ${job}`, replyTo: 'a' });
      starts.at(-1).finish();
      await runner.idle();
    }
    const { reply } = await runner.handleCommand({ text: 'claude:history 2', replyTo: 'a' });
    const lines = reply.split('\n');
    assert.equal(lines[0], 'Last 2 runs:');
    assert.match(lines[1], /three — success, .*\$0\.12, 3 tok$/);
    assert.match(lines[2], /two/);
    assert.equal(lines.length, 3);
  });

  it('says when there is no history yet', async () => {
    const { runner } = setup();
    assert.match((await runner.handleCommand({ text: 'claude:history', replyTo: 'a' })).reply, /No finished runs/);
  });
});

describe('runner: startup recovery', () => {
  it('tells owner about a run a previous process left in the lock, then frees it', async () => {
    const { runner, lock, outboxEntries } = setup({ isAlive: () => false });
    await lock.tryAcquire({ runId: 'old', label: 'fix stuff', replyTo: 'jid-1', logPath: '/l/old.log', agentPid: 55, ownerPid: 1 });
    const recovered = await runner.recoverInterruptedRun();
    assert.equal(recovered?.runId, 'old');
    const [msg] = outboxEntries();
    assert.equal(msg.replyTo, 'owner');
    assert.equal(msg.runId, 'old');
    assert.match(msg.text, /interrupted/);
    assert.match(msg.text, /\/l\/old\.log/);
    assert.doesNotMatch(msg.text, /still running/);
    assert.equal(await lock.current(), null);
  });

  it('warns when the old agent process is still alive', async () => {
    const { runner, lock, outboxEntries } = setup({ isAlive: (pid) => pid === 55 });
    await lock.tryAcquire({ runId: 'old', agentPid: 55 });
    await runner.recoverInterruptedRun();
    assert.match(outboxEntries()[0].text, /pid 55.*still running/s);
  });

  it('does nothing when there is no lock, and never touches the pause flag', async () => {
    const { runner, pause, outboxEntries } = setup();
    const token = await pause.set('safe-restart');
    assert.equal(await runner.recoverInterruptedRun(), null);
    assert.deepEqual(outboxEntries(), []);
    assert.equal((await pause.get())?.token, token);
  });
});

/**
 * Fake issue pipeline: `finish` resolves when the test calls `release(result)`, and can run a
 * follow-up agent pass through the `runAgent` it was given.
 */
function fakeIssues({ prepareError = null } = {}) {
  /** @type {any[]} */
  const prepares = [];
  /** @type {any[]} */
  const finishes = [];
  /** @type {any[]} */
  const recoveries = [];
  let recovery = { ok: true, sha: 'abc1234', branch: 'claude/issue-7-fix-it' };
  return {
    prepares,
    finishes,
    recoveries,
    setRecovery: (r) => (recovery = r),
    issues: {
      async prepare(p) {
        prepares.push(p);
        if (prepareError) throw new Error(prepareError);
        return {
          prompt: '# GitHub issue #7',
          issue: { number: 7, repo: 'o/r', title: 'Fix it' },
          branchName: 'claude/issue-7-fix-it',
          defaultBranch: 'main',
          resumed: false,
          preAgentHeadSha: 'sha0',
        };
      },
      finish(p) {
        return new Promise((resolve) => {
          finishes.push({ ...p, release: (r = { result: 'merged', message: '✅ #7 merged — Fix it', silent: false }) => resolve({ post: {}, ...r }) });
        });
      },
      async commitInterruptedWork(p) {
        recoveries.push(p);
        return recovery;
      },
    },
  };
}

const fakeWorkspaces = {
  async resolveIssueWorkspace(alias) {
    if (alias === 'nope') throw new Error('Unknown workspace alias "nope". Valid aliases: a');
    return { alias: alias ?? 'a', root: '/repos/a' };
  },
};

/** Let queued promise callbacks run. */
const flush = () => new Promise((r) => setImmediate(r));

function issueSetup(opts = {}) {
  const fi = fakeIssues(opts);
  return { ...fi, ...setup({ issues: fi.issues, workspaces: fakeWorkspaces, ...(opts.overrides ?? {}) }) };
}

describe('runner: issue runs', () => {
  it('prepares the issue, runs the agent with the implement workflow in the repo, then reports once', async () => {
    const { runner, starts, prepares, finishes, lock, history, outboxEntries } = issueSetup();
    const { reply } = await runner.handleCommand({ text: 'claude issue:a:7 add tests', replyTo: 'jid-1' });
    assert.match(reply, /^Started run run-1: issue #7 \(Fix it\) in a on `claude\/issue-7-fix-it`\./);
    assert.deepEqual(prepares, [{ issueNumber: 7, alias: 'a', workspaceRoot: '/repos/a', extraInstructions: 'add tests' }]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].opts.prompt, '# GitHub issue #7');
    assert.equal(starts[0].opts.implement, true);
    assert.equal(starts[0].opts.cwd, '/repos/a');
    const held = await lock.current();
    assert.equal(held?.kind, 'issue');
    assert.equal(held?.issueNumber, 7);
    assert.equal(held?.workspaceAlias, 'a');
    assert.equal(held?.workspaceRoot, '/repos/a');

    starts[0].finish('success', 'implemented');
    await flush();
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].agent.outcome, 'success');
    assert.equal(finishes[0].repo, '/repos/a');
    assert.equal(finishes[0].preAgentHeadSha, 'sha0');
    assert.equal(outboxEntries().length, 0, 'nothing is sent until post-run is done');
    finishes[0].release();
    await runner.idle();

    assert.deepEqual(
      outboxEntries().map((e) => [e.replyTo, e.text]),
      [['jid-1', '✅ #7 merged — Fix it']]
    );
    assert.equal(await lock.current(), null);
    assert.equal(history[0].result, 'merged');
    assert.equal(history[0].issueNumber, 7);
    assert.equal(history[0].issueRepo, 'o/r');
  });

  it('rejects an unknown alias without taking the lock', async () => {
    const { runner, prepares, lock } = issueSetup();
    const { reply } = await runner.handleCommand({ text: 'claude issue:nope:7', replyTo: 'a' });
    assert.match(reply, /Unknown workspace alias "nope"/);
    assert.equal(prepares.length, 0);
    assert.equal(await lock.current(), null);
  });

  it('replies with a prep failure and frees the lock', async () => {
    const { runner, starts, lock } = issueSetup({ prepareError: 'Git setup for issue #7 failed: Working tree is not clean.' });
    const { reply } = await runner.handleCommand({ text: 'claude issue:7', replyTo: 'a' });
    assert.equal(reply, 'Git setup for issue #7 failed: Working tree is not clean.');
    assert.equal(starts.length, 0);
    assert.equal(await lock.current(), null);
  });

  it('is refused while busy, before touching the repo', async () => {
    const { runner, prepares } = issueSetup();
    await runner.handleCommand({ text: 'claude something', replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'b' });
    assert.match(reply, /busy/);
    assert.equal(prepares.length, 0);
  });

  it('runs the autofix pass as the active agent, which claude:stop can stop', async () => {
    const { runner, starts, finishes, outboxEntries } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'a' });
    starts[0].finish('success');
    await flush();
    const autofix = finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' });
    await flush();
    assert.equal(starts.length, 2);
    assert.equal(starts[1].opts.prompt, 'fix review');
    assert.equal(starts[1].opts.implement, undefined);
    assert.equal(starts[1].opts.cwd, '/repos/a');
    assert.equal(starts[1].opts.logPath, '/runner/logs/agent-runs/run-1-autofix.log');
    assert.equal((await runner.status()).activeRun?.phase, 'agent');

    assert.match((await runner.handleCommand({ text: 'claude:stop', replyTo: 'a' })).reply, /Stopping run run-1/);
    assert.equal(starts[1].stopped, true);
    assert.equal((await autofix).outcome, 'stopped');

    // after a stop, no further agent pass starts
    assert.equal((await finishes[0].runAgent({ prompt: 'again', label: 'autofix' })).outcome, 'stopped');
    assert.equal(starts.length, 2);
    finishes[0].release({ result: 'pr_open', message: '⚠️ #7 — Fix it: merge blocked by the autofix pass — needs a look.', silent: false });
    await runner.idle();
    assert.match(outboxEntries()[0].text, /merge blocked/);
  });

  it('re-publishes the active-run file for the autofix pass, and counts its cost in history', async () => {
    const { runner, starts, finishes, tracked, history } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'a' });
    starts[0].finish('success');
    await flush();
    const autofix = finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' });
    await flush();
    assert.equal(tracked.length, 2);
    assert.equal(tracked[0].finished, true);
    assert.equal(tracked[1].record.agentPid, starts[1].pid);
    const p = { model: 'm', turns: 1, outputTokens: 1, contextTokens: 1, lastActivity: 'Edit' };
    starts[1].opts.onProgress(p);
    assert.deepEqual(tracked[1].progress, [p]);
    starts[1].finish('success');
    await autofix;
    finishes[0].release();
    await runner.idle();
    assert.equal(tracked[1].finished, true);
    assert.equal(history[0].costUsd.toFixed(2), '0.24');
    assert.equal(history[0].followUps[0].costUsd, 0.12);
  });

  it('explains that post-run itself cannot be interrupted', async () => {
    const { runner, starts, finishes } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'a' });
    starts[0].finish('success');
    await flush();
    assert.match((await runner.handleCommand({ text: 'claude:stop', replyTo: 'a' })).reply, /in post-run.*can't be interrupted/s);
    finishes[0].release();
    await runner.idle();
  });

  it('the shared entry point: cron runs report to owner, skip silent results, and resolve with the result', async () => {
    const { runner, starts, finishes, outboxEntries } = issueSetup();
    const { reply, done } = await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    assert.match(reply, /Started run run-1/);
    starts[0].finish('success');
    await flush();
    finishes[0].release({ result: 'no_changes', message: 'ℹ️ #7 — Fix it: the agent made no changes.', silent: true });
    assert.equal(await done, 'no_changes');
    assert.deepEqual(outboxEntries(), []);
  });
});

describe('runner: startup recovery of an issue run', () => {
  const rec = { runId: 'old', kind: 'issue', label: 'issue a#7', replyTo: 'jid-1', workspaceRoot: '/repos/a', workspaceAlias: 'a', issueNumber: 7, agentPid: 55, logPath: '/l/old.log' };

  it('WIP-commits the leftover work and says how to resume', async () => {
    const { runner, lock, recoveries, outboxEntries } = issueSetup({ overrides: { isAlive: () => false } });
    await lock.tryAcquire(rec);
    await runner.recoverInterruptedRun();
    assert.deepEqual(recoveries, [{ repo: '/repos/a', issueNumber: 7 }]);
    const [msg] = outboxEntries();
    assert.equal(msg.replyTo, 'owner');
    assert.match(msg.text, /interrupted/);
    assert.match(msg.text, /committed as WIP `abc1234` on `claude\/issue-7-fix-it`\. Send `claude issue:a:7` to resume\./);
    assert.equal(await lock.current(), null);
  });

  it('leaves the repo alone while the old agent may still be writing', async () => {
    const { runner, lock, recoveries, outboxEntries } = issueSetup({ overrides: { isAlive: () => true } });
    await lock.tryAcquire(rec);
    await runner.recoverInterruptedRun();
    assert.deepEqual(recoveries, []);
    assert.match(outboxEntries()[0].text, /still running/);
  });

  it('does not commit on a branch that is not the issue branch', async () => {
    const { runner, lock, setRecovery, outboxEntries } = issueSetup({ overrides: { isAlive: () => false } });
    setRecovery({ ok: false, reason: 'not_issue_branch', branch: 'main' });
    await lock.tryAcquire(rec);
    await runner.recoverInterruptedRun();
    assert.match(outboxEntries()[0].text, /uncommitted changes on `main`, which is not the issue branch/);
  });
});

describe('runner: an orphaned agent at startup', () => {
  it('is stopped first, then its issue work is WIP-committed', async () => {
    const stopped = [];
    const { runner, lock, recoveries, outboxEntries } = issueSetup({
      overrides: { isAlive: () => true, stopOrphanAgent: async (pid) => (stopped.push(pid), true) },
    });
    await lock.tryAcquire({ runId: 'old', kind: 'issue', workspaceRoot: '/repos/a', workspaceAlias: 'a', issueNumber: 7, agentPid: 55 });
    await runner.recoverInterruptedRun();
    assert.deepEqual(stopped, [55]);
    assert.equal(recoveries.length, 1);
    assert.match(outboxEntries()[0].text, /pid 55\) outlived the runner and has been stopped.*WIP `abc1234`/s);
  });
});
