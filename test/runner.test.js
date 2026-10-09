import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';
import { createRunLock } from '../src/runLock.js';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createRunQueue } from '../src/runQueue.js';
import { createManualPause } from '../src/manualPause.js';
import { createOutbox, OUTBOX_KEY } from '../src/outbox.js';
import { createUsageLimitPause } from '../src/usageLimitPause.js';
import { createMemoryStore } from './helpers/memoryStore.js';

/** Controllable AgentBackend fake: each start() creates a run you settle by hand. */
/** @param {import('../src/agentBackend/index.js').AgentModelChoice} [modelChoice] */
function fakeBackend(modelChoice = { name: 'sonnet', source: 'default' }) {
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
          model: opts.model ? { name: opts.model, source: opts.modelSource ?? /** @type {const} */ ('prefix') } : modelChoice,
          stopped: false,
          pid: 900 + starts.length,
          done,
          stop() {
            run.stopped = true;
            settle(result('stopped', 'partial'));
          },
          finish: (outcome = 'success', text = 'All done', sessionId = null) => {
            const r = result(outcome, text);
            settle({ ...r, usage: { ...r.usage, sessionId } });
          },
          /** @param {import('../src/agentBackend/index.js').AgentUsageLimit} limit @param {number} [turns] */
          hitLimit: (limit, turns = 3) => {
            const r = result('limited', "You've hit your session limit");
            settle({ ...r, exitCode: 1, limit, usage: { ...r.usage, turns } });
          },
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
  const queue = createRunQueue({ store, maxLength: 3 });
  const outbox = createOutbox({ store });
  const { backend, starts } = fakeBackend(overrides.modelChoice);
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
        setRecord: async (r) => void (t.record = r),
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
  const manualPause = createManualPause({ store, now: () => clock });
  const usageLimit = createUsageLimitPause({ store, now: () => clock });
  const runner = createRunner({
    lock,
    pause,
    manualPause,
    usageLimit,
    queue,
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
    freeformPreamble: 'FREEFORM PREAMBLE',
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
    manualPause,
    usageLimit,
    queue,
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
  it('says which model a run uses in its acknowledgment and report when it came from the workspace', async () => {
    const { runner, starts, outboxEntries } = setup({ modelChoice: { name: 'opus', source: 'workspace' } });
    const { reply } = await runner.handleCommand({ text: 'claude list the repos', replyTo: 'jid-1' });
    assert.match(reply, /, model opus \(workspace\)\.\nLog:/);
    starts[0].finish('success', 'Here are the repos');
    await runner.idle();
    assert.match(outboxEntries()[0].text, /Here are the repos\nModel: opus \(workspace\)$/);
  });

  it('runs a model-prefixed freeform request on that model and says so', async () => {
    const { runner, starts, outboxEntries } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude Haiku : restart pm2', replyTo: 'jid-1' });
    assert.equal(starts[0].opts.model, 'haiku');
    assert.equal(starts[0].opts.prompt, 'restart pm2');
    assert.match(reply, /, model haiku \(prefix\)\.\nLog:/);
    starts[0].finish('success', 'Done');
    await runner.idle();
    assert.match(outboxEntries()[0].text, /Done\nModel: haiku \(prefix\)$/);
  });

  it('runs a model-prefixed Joplin note on that model', async () => {
    const { runner, starts } = setup();
    await runner.handleCommand({ text: 'claude opus: joplin:Plan', replyTo: 'a' });
    assert.equal(starts[0].opts.model, 'opus');
  });

  it('keeps no model for a plain request, or one that is not a prefix', async () => {
    const { runner, starts } = setup();
    await runner.handleCommand({ text: 'claude opus rocks', replyTo: 'a' });
    assert.equal('model' in starts[0].opts, false);
    assert.equal(starts[0].opts.prompt, 'opus rocks');
  });

  it('a queued request keeps its model choice', async () => {
    const { runner, starts } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'a' });
    await runner.handleCommand({ text: 'claude sonnet: two', replyTo: 'a' });
    starts[0].finish();
    await runner.idle();
    assert.equal(starts[1].opts.model, 'sonnet');
    assert.equal(starts[1].opts.prompt, 'two');
  });

  it('rejects a model prefix in front of an issue run', async () => {
    const { runner, starts } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude opus: issue:12', replyTo: 'a' });
    assert.match(reply, /issue runs/);
    assert.equal(starts.length, 0);
  });

  it('leaves replies unchanged for a run on the runner default', async () => {
    const { runner, starts, outboxEntries } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude list the repos', replyTo: 'jid-1' });
    assert.doesNotMatch(reply, /model/);
    starts[0].finish('success', 'Here are the repos');
    await runner.idle();
    assert.doesNotMatch(outboxEntries()[0].text, /Model:/);
  });

  it('starts the agent in the workspace, replies "started", and posts the result to the outbox', async () => {
    const { runner, starts, lock, history, outboxEntries } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude list the repos', replyTo: 'jid-1' });
    assert.match(reply, /Started run run-1/);
    assert.equal(starts.length, 1);
    assert.deepEqual(
      { ...starts[0].opts, onProgress: undefined },
      { prompt: 'list the repos', preamble: 'FREEFORM PREAMBLE', cwd: '/home/u/Projects', logPath: '/runner/logs/agent-runs/run-1.log', onProgress: undefined }
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

  it('queues a second request while busy, then starts it when the first run finishes', async () => {
    const { runner, starts, lock, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude two', replyTo: 'b' });
    assert.match(reply, /Queued \(position 1\): two\. Run run-1 \(one\) is in progress/);
    assert.equal(starts.length, 1);

    starts[0].finish();
    await runner.idle();
    assert.equal(starts.length, 2);
    assert.equal(starts[1].opts.prompt, 'two');
    assert.equal((await lock.current())?.replyTo, 'b');
    const [done1, started2] = outboxEntries();
    assert.equal(done1.replyTo, 'a');
    assert.equal(started2.replyTo, 'b');
    assert.match(started2.text, /^Queued request "two": Started run run-\d+ in /);
    assert.equal((await runner.status()).queued, 0);
  });

  it('runs queued requests one at a time, in order', async () => {
    const { runner, starts } = setup();
    for (const t of ['one', 'two', 'three']) await runner.handleCommand({ text: `claude ${t}`, replyTo: 'a' });
    assert.equal((await runner.status()).queued, 2);
    starts[0].finish();
    await runner.idle();
    assert.equal(starts.length, 2);
    assert.equal(starts[1].opts.prompt, 'two');
    starts[1].finish();
    await runner.idle();
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['one', 'two', 'three']);
  });

  it('a new request waits behind queued ones even if the runner looks idle', async () => {
    const { runner, queue, starts, pause } = setup();
    const token = await pause.set('safe-restart');
    await runner.handleCommand({ text: 'claude first', replyTo: 'a' });
    await pause.clear(/** @type {string} */ (token));
    const { reply } = await runner.handleCommand({ text: 'claude second', replyTo: 'a' });
    assert.match(reply, /Queued \(position 2\)/);
    await runner.idle();
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['first']);
    assert.deepEqual((await queue.list()).map((q) => q.label), ['second']);
  });

  it('refuses a request when the queue is full', async () => {
    const { runner } = setup();
    for (const t of ['0', '1', '2', '3']) await runner.handleCommand({ text: `claude ${t}`, replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude overflow', replyTo: 'a' });
    assert.match(reply, /queue is full/);
  });

  it('reports a queued request that fails to start, and moves on to the next', async () => {
    const { runner, starts, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'a' });
    await runner.handleCommand({ text: 'claude joplin:missing', replyTo: 'b' });
    await runner.handleCommand({ text: 'claude three', replyTo: 'c' });
    starts[0].finish();
    await runner.idle();
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['one', 'three']);
    const failed = outboxEntries().find((e) => e.replyTo === 'b');
    assert.match(failed?.text ?? '', /did not start: Failed to read Joplin note/);
  });

  it('claude:queue lists the waiting requests, and claude:queue clear drops them', async () => {
    const { runner, starts } = setup();
    assert.equal((await runner.handleCommand({ text: 'claude:queue', replyTo: 'a' })).reply, 'The queue is empty.');
    for (const t of ['one', 'two', 'three']) await runner.handleCommand({ text: `claude ${t}`, replyTo: 'a' });
    assert.equal((await runner.handleCommand({ text: 'claude:queue', replyTo: 'a' })).reply, 'Queued (2):\n1. two\n2. three');
    assert.equal((await runner.handleCommand({ text: 'claude:queue clear', replyTo: 'a' })).reply, 'Dropped 2 queued requests.');
    starts[0].finish();
    await runner.idle();
    assert.equal(starts.length, 1);
  });

  it('drains a queue left by a previous process once the pause is lifted', async () => {
    const { runner, queue, pause, starts } = setup();
    await queue.push({ id: 'q1', cmd: { kind: 'freeform', prompt: 'left over' }, replyTo: 'a', label: 'left over', queuedAt: '' });
    const token = await pause.set('safe-restart');
    await runner.drainQueue();
    assert.equal(starts.length, 0);
    await pause.clear(/** @type {string} */ (token));
    await runner.drainQueue();
    assert.equal(starts[0]?.opts.prompt, 'left over');
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

  it('queues instead of starting while paused', async () => {
    const { runner, pause, starts } = setup();
    await pause.set('safe-restart');
    const { reply } = await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    assert.match(reply, /Queued \(position 1\).*paused \(safe-restart\)/);
    assert.equal(starts.length, 0);
  });

  it('backs off if safe-restart paused between the pause check and taking the lock', async () => {
    const { runner, pause, lock, starts } = setup();
    const realGet = pause.get;
    let calls = 0;
    pause.get = async () => (++calls === 1 ? null : realGet());
    await pause.set('safe-restart');
    const { reply } = await runner.handleCommand({ text: 'claude x', replyTo: 'a' });
    assert.match(reply, /Queued.*paused/);
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

describe('runner: a freeform run finds its workspace', () => {
  const allowlist = {
    resolveIssueWorkspace: async (alias) => ({ alias, root: `/repos/${alias}` }),
    list: async () => [
      { alias: 'bot', root: '/repos/bot' },
      { alias: 'chess', root: '/repos/chess' },
    ],
  };
  // /repos doesn't exist, so each path resolves to itself after a few failed realpath calls
  /** Resolves once `cond` holds (or after 2s). @param {() => Promise<boolean>} cond */
  const until = async (cond) => {
    for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('records the first edit or command in a workspace on the active run, the lock, status and history', async () => {
    const changes = [];
    const { runner, starts, lock, tracked, history } = setup({ workspaces: allowlist, onChange: (w) => changes.push(w) });
    await runner.handleCommand({ text: 'claude fix the bot', replyTo: 'jid' });
    const { onTouch } = starts[0].opts;
    onTouch({ action: 'command', paths: ['/home/u/Projects'] });
    onTouch({ action: 'edit', paths: ['/repos/bot/src/a.js'] });
    onTouch({ action: 'edit', paths: ['/repos/chess/b.js'] });
    await until(async () => changes.includes('inferred-workspace'));
    // time for the later touch to have been looked at too
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await lock.current())?.inferredWorkspace, 'bot');
    assert.equal(tracked[0].record.inferredWorkspace, 'bot');
    assert.equal((await runner.status()).activeRun?.inferredWorkspace, 'bot');
    assert.equal(changes.filter((c) => c === 'inferred-workspace').length, 1);
    starts[0].finish();
    await runner.idle();
    assert.equal(history[0].inferredWorkspace, 'bot');
    assert.equal(history[0].workspaceAlias, undefined);
  });

  it('a run that touches no workspace has none', async () => {
    const { runner, starts, history } = setup({ workspaces: allowlist });
    await runner.handleCommand({ text: 'claude look around', replyTo: 'jid' });
    starts[0].opts.onTouch({ action: 'command', paths: ['/home/u/Projects', '/tmp/x'] });
    await new Promise((r) => setTimeout(r, 50));
    starts[0].finish();
    await runner.idle();
    assert.equal('inferredWorkspace' in history[0], false);
  });

  it('only freeform runs infer one', async () => {
    const { runner, starts } = setup({ workspaces: allowlist });
    await runner.handleCommand({ text: 'claude joplin:Plan', replyTo: 'jid' });
    assert.equal(starts[0].opts.onTouch, undefined);
  });

  it('startup recovery keeps it in the interrupted run\'s history row', async () => {
    const { runner, lock, history } = setup({ isAlive: () => false });
    await lock.tryAcquire({ runId: 'old', kind: 'freeform', label: 'x', startedAt: '2026-09-24T11:00:00Z', inferredWorkspace: 'bot' });
    await runner.recoverInterruptedRun();
    assert.equal(history[0].inferredWorkspace, 'bot');
  });
});

describe('runner: joplin', () => {
  it('uses the note body as the prompt', async () => {
    const { runner, starts } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude joplin:Plan', replyTo: 'a' });
    assert.match(reply, /Joplin note "Plan"/);
    assert.equal(starts[0].opts.prompt, 'note instructions');
    assert.equal(starts[0].opts.preamble, 'FREEFORM PREAMBLE');
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
    assert.deepEqual(await runner.status(), { busy: false, activeRun: null, paused: false, queued: 0 });
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

describe('runner: state change notification', () => {
  it('tells onChange when a run starts, progresses, changes phase and ends', async () => {
    /** @type {string[]} */
    const changes = [];
    const { runner, starts } = setup({ onChange: (r) => changes.push(r) });
    await runner.handleCommand({ text: 'claude job', replyTo: 'a' });
    assert.deepEqual(changes, ['run-started']);
    starts[0].opts.onProgress({ model: 'm', turns: 1, outputTokens: 1, contextTokens: 1, lastActivity: 'Bash: ls' });
    assert.deepEqual(changes, ['run-started', 'progress']);
    starts[0].finish();
    await runner.idle();
    assert.deepEqual(changes, ['run-started', 'progress', 'phase', 'run-ended']);
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

  it('records the interrupted run in history, so its room shows it', async () => {
    const { runner, lock, history } = setup({ isAlive: () => false });
    await lock.tryAcquire({ runId: 'old', kind: 'freeform', label: 'fix stuff', replyTo: 'jid-1', logPath: '/l/old.log', startedAt: '2026-09-26T10:00:00Z', ownerPid: 1 });
    await runner.recoverInterruptedRun();
    assert.equal(history.length, 1);
    assert.equal(history[0].runId, 'old');
    assert.equal(history[0].kind, 'freeform');
    assert.equal(history[0].label, 'fix stuff');
    assert.equal(history[0].outcome, 'interrupted');
    assert.equal(history[0].startedAt, '2026-09-26T10:00:00Z');
    assert.equal(typeof history[0].endedAt, 'string');
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
function fakeIssues({ prepareError = null, labels = [] } = {}) {
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
          labels,
        };
      },
      finish(p) {
        return new Promise((resolve) => {
          finishes.push({ ...p, release: (r = { result: 'merged', message: '✅ #7 merged — Fix it', silent: false }) => resolve({ post: {}, mergeNetworkError: false, ...r }) });
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
  /** @param {string[]} labels @param {'manual' | 'cron'} [trigger] */
  const labelRun = async (labels, trigger = 'manual') => {
    const h = issueSetup({ labels });
    const r = await h.runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger });
    return { ...h, r };
  };

  it('runs a labelled issue on that model, autofix included, and says so', async () => {
    for (const trigger of /** @type {const} */ (['manual', 'cron'])) {
      const { r, starts, finishes, outboxEntries } = await labelRun([' Model:Opus '], trigger);
      assert.match(r.reply, /, model opus \(label\)\./);
      assert.equal(starts[0].opts.model, 'opus');
      starts[0].finish();
      await flush();
      const autofix = finishes[0].runAgent({ prompt: 'fix', label: 'autofix' });
      await flush();
      assert.equal(starts[1].opts.model, 'opus');
      assert.equal(starts[1].opts.modelSource, 'label');
      starts[1].finish();
      await autofix;
      finishes[0].release();
      await r.done;
      assert.match(outboxEntries()[0].text, /Model: opus \(label\)$/);
    }
  });

  it('lets the label beat the workspace setting', async () => {
    const { starts } = await labelRun(['model:sonnet']);
    assert.equal(starts[0].opts.model, 'sonnet');
    assert.equal(starts[0].opts.modelSource, 'label');
  });

  it('warns about an unknown model label and runs without a requested model', async () => {
    const { r, starts } = await labelRun(['model:gpt']);
    assert.equal(starts[0].opts.model, undefined);
    assert.match(r.reply, /Ignored unknown model label "model:gpt"/);
  });

  it('picks the strongest of conflicting model labels and warns', async () => {
    const { r, starts } = await labelRun(['model:haiku', 'model:opus']);
    assert.equal(starts[0].opts.model, 'opus');
    assert.match(r.reply, /Several model labels.*using the strongest, opus/);
  });

  it('behaves as before for an issue without a model label', async () => {
    const { r, starts } = await labelRun(['bug']);
    assert.equal(starts[0].opts.model, undefined);
    assert.doesNotMatch(r.reply, /model|Ignored/);
  });

  it('prepares the issue, runs the agent with the implement workflow in the repo, then reports once', async () => {
    const { runner, starts, prepares, finishes, lock, history, outboxEntries } = issueSetup();
    const { reply } = await runner.handleCommand({ text: 'claude issue:a:7 add tests', replyTo: 'jid-1' });
    assert.match(reply, /^Started run run-1: issue #7 \(Fix it\) in a on `claude\/issue-7-fix-it`\./);
    assert.deepEqual(prepares, [{ issueNumber: 7, alias: 'a', workspaceRoot: '/repos/a', extraInstructions: 'add tests' }]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].opts.prompt, '# GitHub issue #7');
    assert.equal(starts[0].opts.implement, true);
    // post-run commits, reviews and merges an issue run, so it gets the base preamble
    assert.equal(starts[0].opts.preamble, 'PREAMBLE');
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
    assert.equal(finishes[0].trigger, 'manual');
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
    assert.equal(history[0].prUrl, null);
  });

  it("records the PR's url in history, for the office's hover", async () => {
    const { runner, starts, finishes, history } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'jid-1' });
    starts[0].finish('success', 'done');
    await flush();
    finishes[0].release({ result: 'pr_open', message: '✅ #7 PR open', silent: false, post: { prResult: { ok: true, url: 'https://github.com/o/r/pull/9' } } });
    await runner.idle();
    assert.equal(history[0].prUrl, 'https://github.com/o/r/pull/9');
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

  it('is queued while busy, before touching the repo', async () => {
    const { runner, prepares } = issueSetup();
    await runner.handleCommand({ text: 'claude something', replyTo: 'a' });
    const { reply } = await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'b' });
    assert.match(reply, /Queued \(position 1\): issue a#7/);
    assert.equal(prepares.length, 0);
  });

  it('the cron backs off while requests are queued', async () => {
    const { runner, prepares, queue } = issueSetup();
    await queue.push({ id: 'q1', cmd: { kind: 'freeform', prompt: 'x' }, replyTo: 'a', label: 'x', queuedAt: '' });
    const r = await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    assert.equal(r.refused, 'busy');
    assert.equal(prepares.length, 0);
  });

  it('runs the autofix pass as the active agent, which claude:stop can stop', async () => {
    const { runner, starts, finishes, outboxEntries, history } = issueSetup();
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
    // the run was stopped, though its first pass succeeded (the office shows it gone home)
    assert.equal(history[0].outcome, 'stopped');
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
    assert.equal(finishes[0].trigger, 'cron');
    finishes[0].release({ result: 'no_changes', message: 'ℹ️ #7 — Fix it: the agent made no changes.', silent: true });
    assert.deepEqual(await done, { result: 'no_changes', mergeNetworkError: false });
    assert.deepEqual(outboxEntries(), []);
  });

  it('the shared entry point passes on that a merge failed only on a network error', async () => {
    const { runner, starts, finishes } = issueSetup();
    const { done } = await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    starts[0].finish('success');
    await flush();
    finishes[0].release({ result: 'pr_open', message: '⚠️ #7 — Fix it: auto-merge was not enabled (i/o timeout) — needs a look.', silent: false, mergeNetworkError: true });
    assert.deepEqual(await done, { result: 'pr_open', mergeNetworkError: true });
  });

  it('the shared entry point says when it was refused for the lock, unlike a prep failure', async () => {
    const { runner } = issueSetup();
    await runner.handleCommand({ text: 'claude something', replyTo: 'a' });
    const busy = await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    assert.equal(busy.refused, 'busy');
    assert.equal(busy.done, null);
    const failed = await issueSetup({ prepareError: 'Git setup failed' }).runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    assert.equal(failed.refused, undefined);
    assert.equal(failed.reply, 'Git setup failed');
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

describe('runner: pauses set by hand', () => {
  it('claude:pause with no scope holds every new run for 2h; requests queue and start on claude:resume', async () => {
    const { runner, starts, queue, outboxEntries } = setup();
    const { reply } = await runner.handleCommand({ text: 'claude:pause', replyTo: 'jid-1' });
    assert.match(reply, /^Paused everything for 2h\. No new agent runs start/);

    const queued = await runner.handleCommand({ text: 'claude list the repos', replyTo: 'jid-1' });
    assert.match(queued.reply, /^Queued \(position 1\).*agent-runner is paused \(paused by hand: everything for 2h\)/);
    assert.equal(starts.length, 0);
    assert.equal((await runner.status()).paused, true);

    assert.equal((await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' })).reply, 'Resumed: cleared 1 pause.');
    await runner.idle();
    assert.equal(starts.length, 1);
    assert.equal(await queue.length(), 0);
    assert.match(outboxEntries()[0].text, /^Queued request "list the repos": Started run run-\d/);
  });

  it('ends a general pause after its duration', async () => {
    const { runner, starts, advance } = setup();
    await runner.handleCommand({ text: 'claude:pause 30m lunch', replyTo: 'jid-1' });
    assert.match((await runner.handleCommand({ text: 'claude go', replyTo: 'jid-1' })).reply, /paused by hand: everything for 30m \(lunch\)/);
    advance(31 * 60_000);
    await runner.drainQueue();
    assert.equal(starts.length, 1);
  });

  it('a workspace pause refuses issue runs there without queueing, and other workspaces carry on', async () => {
    const { runner, starts, queue } = issueSetup();
    assert.match((await runner.handleCommand({ text: 'claude:pause a 1h fixing by hand', replyTo: 'jid-1' })).reply, /^Paused a for 1h \(fixing by hand\)\. No issue runs start in a/);
    const { reply } = await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'jid-1' });
    assert.equal(reply, 'a is paused by hand (a for 1h (fixing by hand)). Send claude:resume a first.');
    assert.equal(starts.length, 0);
    assert.equal(await queue.length(), 0);

    // a freeform run still starts, and is told to leave the paused workspace alone
    await runner.handleCommand({ text: 'claude check the disk', replyTo: 'jid-1' });
    assert.equal(starts.length, 1);
    assert.match(starts[0].opts.preamble, /^FREEFORM PREAMBLE\n- The owner is working by hand in these workspaces[\s\S]*  - a \(\/repos\/a\): fixing by hand$/);
  });

  it('rejects an unknown workspace alias and too long a pause', async () => {
    const { runner, manualPause } = issueSetup();
    assert.match((await runner.handleCommand({ text: 'claude:pause nope 1h', replyTo: 'jid-1' })).reply, /Unknown workspace alias "nope"/);
    assert.match((await runner.handleCommand({ text: 'claude:pause 8d', replyTo: 'jid-1' })).reply, /^Usage: claude:pause/);
    assert.deepEqual(await manualPause.list(), []);
  });

  it('claude:resume <alias> clears only that pause', async () => {
    const { runner, manualPause } = issueSetup();
    await runner.handleCommand({ text: 'claude:pause 1h', replyTo: 'jid-1' });
    await runner.handleCommand({ text: 'claude:pause a', replyTo: 'jid-1' });
    assert.equal((await runner.handleCommand({ text: 'claude:resume a', replyTo: 'jid-1' })).reply, 'Resumed a.');
    assert.deepEqual((await manualPause.list()).map((p) => p.scope), ['all']);
    assert.equal((await runner.handleCommand({ text: 'claude:resume a', replyTo: 'jid-1' })).reply, 'a was not paused.');
  });
});

/** Controllable job launcher fake: each start() creates a job run you settle by hand. */
function fakeJobs({ startError = null } = {}) {
  /** @type {any[]} */
  const starts = [];
  return {
    starts,
    jobs: {
      async start(opts) {
        if (startError) throw new Error(startError);
        /** @type {(r: any) => void} */
        let settle = () => {};
        const run = {
          opts,
          stopped: false,
          pid: 700 + starts.length,
          done: new Promise((r) => (settle = r)),
          stop() {
            run.stopped = true;
            settle({ outcome: 'stopped', exitCode: null, signal: 'SIGTERM' });
          },
          /** @param {number} [exitCode] */
          exit: (exitCode = 0) => settle({ outcome: exitCode === 0 ? 'success' : 'failed', exitCode, signal: null }),
        };
        starts.push(run);
        return run;
      },
    },
  };
}

const cleanupJob = {
  name: 'cleanup_agent',
  room: 'reddit-bot',
  cwd: '/home/u/reddit-bot',
  command: 'npm run cleanup_agent',
  at: '02:00',
  logFile: '/home/u/reddit-bot/reports/cron-cleanup.log',
};

function jobSetup({ startError = null, overrides = {} } = {}) {
  const fj = fakeJobs({ startError });
  return { ...fj, jobStarts: fj.starts, ...setup({ jobs: fj.jobs, jobTimeoutMs: 1_200_000, ...overrides }) };
}

describe('runner: scheduled jobs', () => {
  it('runs the command as-is under the lock, stays quiet on success, and records trigger: schedule', async () => {
    const { runner, jobStarts, starts, lock, history, outboxEntries, advance, tracked } = jobSetup();
    const r = await runner.submitJob(cleanupJob);
    assert.equal(r.accepted, true);
    assert.match(r.reply, /Started run run-1: scheduled job cleanup_agent/);
    assert.equal(starts.length, 0, 'no agent');
    assert.deepEqual(jobStarts[0].opts, {
      command: 'npm run cleanup_agent',
      cwd: '/home/u/reddit-bot',
      logPath: '/home/u/reddit-bot/reports/cron-cleanup.log',
      env: { AGENT_RUNNER_USAGE_FILE: '/runner/logs/agent-runs/run-1.usage.jsonl' },
      timeoutMs: 1_200_000,
    });
    const held = await lock.current();
    assert.equal(held?.kind, 'job');
    assert.equal(held?.trigger, 'schedule');
    assert.equal(held?.agentPid, 700);
    assert.equal(tracked[0].record.label, 'scheduled job cleanup_agent');
    assert.equal((await runner.status()).activeRun?.phase, 'job');

    advance(125_000);
    jobStarts[0].exit(0);
    await runner.idle();
    assert.deepEqual(outboxEntries(), []);
    assert.equal(await lock.current(), null);
    assert.equal(history.length, 1);
    assert.equal(history[0].kind, 'job');
    assert.equal(history[0].trigger, 'schedule');
    assert.equal(history[0].jobName, 'cleanup_agent');
    assert.equal(history[0].room, 'reddit-bot');
    assert.equal(history[0].outcome, 'success');
    assert.equal(history[0].exitCode, 0);
    assert.equal(history[0].durationMs, 125_000);
    assert.equal(history[0].logPath, '/home/u/reddit-bot/reports/cron-cleanup.log');
  });

  it('uses the job timeout, env, and a run log when the job has no log file', async () => {
    const { runner, jobStarts } = jobSetup();
    const { logFile, ...noLog } = cleanupJob;
    await runner.submitJob({ ...noLog, env: { A: 'b' }, timeoutMinutes: 45 });
    assert.equal(jobStarts[0].opts.logPath, '/runner/logs/agent-runs/run-1.log');
    assert.deepEqual(jobStarts[0].opts.env, { A: 'b', AGENT_RUNNER_USAGE_FILE: '/runner/logs/agent-runs/run-1.usage.jsonl' });
    assert.equal(jobStarts[0].opts.timeoutMs, 45 * 60_000);
  });

  describe('usage file', () => {
    /** A job setup whose usage files live in a map the fake job writes to. */
    function usageSetup() {
      /** @type {Map<string, string>} */
      const files = new Map();
      const s = jobSetup({
        overrides: {
          readUsageFile: async (/** @type {string} */ p) => {
            if (!files.has(p)) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
            return /** @type {string} */ (files.get(p));
          },
        },
      });
      const write = (/** @type {string} */ text) => files.set(s.jobStarts[0].opts.env.AGENT_RUNNER_USAGE_FILE, text);
      return { ...s, write };
    }
    const line = (o) => JSON.stringify(o);
    const tok = (n) => ({ input: n, output: n * 2, cacheRead: n * 3, cacheCreate: n * 4 });

    it('the job cannot override the usage file variable, and its other env applies', async () => {
      const { runner, jobStarts } = usageSetup();
      await runner.submitJob({ ...cleanupJob, env: { A: 'b', AGENT_RUNNER_USAGE_FILE: '/elsewhere' } });
      assert.equal(jobStarts[0].opts.env.A, 'b');
      assert.equal(jobStarts[0].opts.env.AGENT_RUNNER_USAGE_FILE, '/runner/logs/agent-runs/run-1.usage.jsonl');
    });

    it('sums the lines into the history row, with the highest-cost model', async () => {
      const { runner, jobStarts, history, write } = usageSetup();
      await runner.submitJob(cleanupJob);
      write(
        [
          line({ model: 'claude-haiku-4-5', turns: 2, costUsd: 0.1, tokens: tok(1) }),
          line({ model: 'claude-opus-5-5', turns: 3, costUsd: 0.5, tokens: tok(2) }),
          line({ model: null, turns: 1, costUsd: null }),
        ].join('\n') + '\n'
      );
      jobStarts[0].exit(0);
      await new Promise((r) => setTimeout(r, 10));
      const row = history.at(-1);
      assert.equal(row.model, 'claude-opus-5-5');
      assert.equal(row.turns, 6);
      assert.ok(Math.abs(row.costUsd - 0.6) < 1e-9);
      assert.deepEqual(row.tokens, { input: 3, output: 6, cacheRead: 9, cacheCreate: 12 });
    });

    it('uses the first model when no line has a cost, and counts missing numbers as 0', async () => {
      const { runner, jobStarts, history, write } = usageSetup();
      await runner.submitJob(cleanupJob);
      write(line({ model: 'a', turns: 1 }) + '\n' + line({ model: 'b' }));
      jobStarts[0].exit(0);
      await new Promise((r) => setTimeout(r, 10));
      const row = history.at(-1);
      assert.equal(row.model, 'a');
      assert.equal(row.turns, 1);
      assert.equal(row.costUsd, null);
      assert.deepEqual(row.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    });

    it('skips a malformed line without changing the outcome', async () => {
      const { runner, jobStarts, history, write } = usageSetup();
      await runner.submitJob(cleanupJob);
      write('garbage\n' + line({ model: 'a', turns: 2, costUsd: 1, tokens: tok(1) }) + '\n{"x"');
      jobStarts[0].exit(0);
      await new Promise((r) => setTimeout(r, 10));
      const row = history.at(-1);
      assert.equal(row.outcome, 'success');
      assert.equal(row.turns, 2);
    });

    it('leaves the row as it is for no file or an empty one', async () => {
      for (const text of [null, '', '\n']) {
        const { runner, jobStarts, history, write } = usageSetup();
        await runner.submitJob(cleanupJob);
        if (text != null) write(text);
        jobStarts[0].exit(0);
        await new Promise((r) => setTimeout(r, 10));
        const row = history.at(-1);
        assert.equal(row.outcome, 'success');
        for (const k of ['model', 'turns', 'costUsd', 'tokens']) assert.equal(k in row, false, k);
      }
    });

    it('records usage for a failed job and a stopped one', async () => {
      const failed = usageSetup();
      await failed.runner.submitJob(cleanupJob);
      failed.write(line({ model: 'a', turns: 4, costUsd: 1 }));
      failed.jobStarts[0].exit(2);
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(failed.history.at(-1).turns, 4);
      assert.equal(failed.history.at(-1).outcome, 'failed');

      const stopped = usageSetup();
      await stopped.runner.submitJob(cleanupJob);
      stopped.write(line({ model: 'a', turns: 5, costUsd: 1 }));
      stopped.jobStarts[0].stop();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(stopped.history.at(-1).turns, 5);
      assert.equal(stopped.history.at(-1).outcome, 'stopped');
    });
  });

  it('a failure sends one line to owner', async () => {
    const { runner, jobStarts, outboxEntries, advance } = jobSetup();
    await runner.submitJob(cleanupJob);
    advance(61_000);
    jobStarts[0].exit(2);
    await runner.idle();
    const msgs = outboxEntries();
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].replyTo, 'owner');
    assert.equal(msgs[0].text, 'Scheduled job cleanup_agent failed (exit 2) after 1m01s. Log: /home/u/reddit-bot/reports/cron-cleanup.log');
    assert.doesNotMatch(msgs[0].text, /\n/);
  });

  it('waits in the queue behind an active run, then runs without a "started" message', async () => {
    const { runner, starts, jobStarts, queue, outboxEntries, history } = jobSetup();
    await runner.handleCommand({ text: 'claude long job', replyTo: 'jid-1' });
    const r = await runner.submitJob(cleanupJob);
    assert.equal(r.accepted, true);
    assert.match(r.reply, /Queued \(position 1\): scheduled job cleanup_agent/);
    assert.deepEqual((await queue.list()).map((q) => q.cmd.kind), ['job']);
    assert.equal(jobStarts.length, 0);

    starts[0].finish();
    await runner.idle();
    assert.equal(jobStarts.length, 1);
    assert.deepEqual(outboxEntries().map((m) => m.replyTo), ['jid-1']);
    jobStarts[0].exit(0);
    await runner.idle();
    assert.deepEqual(history.map((h) => h.kind), ['freeform', 'job']);
  });

  it('is not accepted when the queue is full', async () => {
    const { runner } = jobSetup();
    for (const t of ['a', 'b', 'c', 'd']) await runner.handleCommand({ text: `claude ${t}`, replyTo: 'x' });
    const r = await runner.submitJob(cleanupJob);
    assert.equal(r.accepted, false);
  });

  it('claude:stop stops a job run, and the stop is reported', async () => {
    const { runner, jobStarts, lock, outboxEntries, history } = jobSetup();
    await runner.submitJob(cleanupJob);
    const { reply } = await runner.handleCommand({ text: 'claude:stop', replyTo: 'jid-2' });
    assert.match(reply, /Stopping run run-1 \(scheduled job cleanup_agent\)/);
    assert.equal(jobStarts[0].stopped, true);
    await runner.idle();
    assert.match(outboxEntries()[0].text, /^Scheduled job cleanup_agent was stopped by claude:stop/);
    assert.equal(outboxEntries()[0].replyTo, 'owner');
    assert.equal(history[0].outcome, 'stopped');
    assert.equal(await lock.current(), null);
  });

  it('tells owner when the command cannot be started, and frees the lock', async () => {
    const { runner, lock, outboxEntries } = jobSetup({ startError: 'EACCES: permission denied' });
    const r = await runner.submitJob(cleanupJob);
    assert.equal(r.accepted, true);
    assert.equal(await lock.current(), null);
    assert.deepEqual(
      outboxEntries().map((m) => [m.replyTo, m.text]),
      [['owner', 'Scheduled job cleanup_agent could not start: EACCES: permission denied']]
    );
  });

  it('startup recovery reports an interrupted job to owner, with no WIP commit', async () => {
    const fi = fakeIssues();
    const { runner, lock, outboxEntries } = jobSetup({ overrides: { issues: fi.issues, workspaces: fakeWorkspaces, isAlive: () => false } });
    await lock.tryAcquire({ runId: 'old', kind: 'job', trigger: 'schedule', jobName: 'cleanup_agent', label: 'scheduled job cleanup_agent', workspaceRoot: '/home/u/reddit-bot', logPath: '/l/c.log', agentPid: 55 });
    await runner.recoverInterruptedRun();
    const [msg] = outboxEntries();
    assert.equal(msg.replyTo, 'owner');
    assert.match(msg.text, /^Run old \(scheduled job cleanup_agent\) was interrupted: agent-runner restarted/);
    assert.match(msg.text, /\/l\/c\.log/);
    assert.deepEqual(fi.recoveries, []);
    assert.equal(await lock.current(), null);
  });

  it('startup recovery says when the job process outlived the runner, without the agent orphan check', async () => {
    /** @type {number[]} */
    const orphanStops = [];
    const { runner, lock, outboxEntries } = jobSetup({ overrides: { isAlive: (pid) => pid === 55, stopOrphanAgent: async (pid) => (orphanStops.push(pid), true) } });
    await lock.tryAcquire({ runId: 'old', kind: 'job', label: 'scheduled job cleanup_agent', agentPid: 55 });
    await runner.recoverInterruptedRun();
    assert.deepEqual(orphanStops, []);
    assert.match(outboxEntries()[0].text, /Its process \(pid 55\) is still running/);
  });
});

describe('runner: active log', () => {
  it('names the log the active run writes now: its own, then its autofix pass', async () => {
    const { runner, starts, finishes } = issueSetup();
    assert.equal(runner.activeLog(), null);
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'a' });
    assert.deepEqual(runner.activeLog(), { runId: 'run-1', logPath: '/runner/logs/agent-runs/run-1.log' });
    starts[0].finish('success');
    await flush();
    const autofix = finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' });
    await flush();
    assert.deepEqual(runner.activeLog(), { runId: 'run-1', logPath: '/runner/logs/agent-runs/run-1-autofix.log' });
    starts[1].finish('success');
    await autofix;
    finishes[0].release({ result: 'merged', message: 'done', silent: false });
    await runner.idle();
    assert.equal(runner.activeLog(), null);
  });
});

describe('runner: active log of a scheduled job', () => {
  it('starts a job log that other runs append to at its size when the job started', async () => {
    const { runner, jobStarts } = jobSetup({ overrides: { logSize: async (path) => (path === cleanupJob.logFile ? 1234 : 0) } });
    await runner.submitJob(cleanupJob);
    assert.deepEqual(runner.activeLog(), { runId: 'run-1', logPath: cleanupJob.logFile, fromByte: 1234 });
    jobStarts[0].exit(0);
    await runner.idle();
  });

  it('reads a run log of its own from the start', async () => {
    const { logFile, ...noLog } = cleanupJob;
    const { runner, jobStarts } = jobSetup({ overrides: { logSize: async () => 99 } });
    await runner.submitJob(noLog);
    assert.deepEqual(runner.activeLog(), { runId: 'run-1', logPath: '/runner/logs/agent-runs/run-1.log' });
    jobStarts[0].exit(0);
    await runner.idle();
  });
});


describe('runner: the usage limit', () => {
  // the clock starts at 13:00 BST
  const LIMIT = { resetsAt: '2026-09-24T14:02:00.000Z', note: 'resets 3pm Europe/London', timeZone: 'Europe/London' };
  const NOTICE = '⏸ Usage limit hit: pausing agent runs until 15:02 (resets 3pm Europe/London).';

  it('holds every new run until the reset, tells owner once, and picks up silently when it ends', async () => {
    const { runner, starts, jobStarts, history, outboxEntries, advance } = jobSetup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    await runner.handleCommand({ text: 'claude two', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT);
    await runner.idle();

    assert.equal(starts.length, 1, 'the queued request waits');
    assert.equal(history[0].outcome, 'limited');
    assert.deepEqual(history[0].limit, LIMIT);
    assert.deepEqual(outboxEntries().filter((e) => e.replyTo === 'owner').map((e) => e.text), [`${NOTICE} 1 request queued.`]);
    assert.match(outboxEntries().find((e) => e.replyTo === 'jid-1')?.text ?? '', /^Run run-1 \(one\) stopped: the agent hit its usage limit\.\nLog: /);

    const r = await runner.handleCommand({ text: 'claude three', replyTo: 'jid-1' });
    assert.match(r.reply, /^Queued \(position 2\): three\. agent-runner is paused \(usage limit hit, until 15:02\)\./);
    assert.match((await runner.submitJob(cleanupJob)).reply, /^Queued \(position 3\)/);
    assert.equal(jobStarts.length, 0, 'the scheduled job waits');
    assert.equal((await runner.status()).paused, true);

    const sent = outboxEntries().length;
    advance(61 * 60_000);
    await runner.drainQueue();
    assert.equal(starts.length, 1, 'still paused before the reset');
    advance(61 * 60_000);
    await runner.drainQueue();
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['one', 'two']);
    // no "resumed" message: only the queued request's own "started"
    assert.deepEqual(outboxEntries().slice(sent).map((e) => [e.replyTo, e.text.split(':')[0]]), [['jid-1', 'Queued request "two"']]);
  });

  it('a model-prefixed request the limit stops before it starts is re-queued with its model', async () => {
    const { runner, starts, advance } = setup();
    await runner.handleCommand({ text: 'claude opus: one', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT, 1);
    await runner.idle();
    advance(122 * 60_000);
    await runner.drainQueue();
    assert.equal(starts.length, 2);
    assert.equal(starts[1].opts.model, 'opus');
    assert.equal(starts[1].opts.prompt, 'one');
  });

  it("an issue run for owner (the cron) sends one message: the notice, then the run's report; the pause is set before post-run", async () => {
    const { runner, starts, finishes, usageLimit, outboxEntries } = issueSetup();
    await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    starts[0].hitLimit(LIMIT);
    await flush();
    assert.equal((await usageLimit.get())?.until, LIMIT.resetsAt);
    assert.equal(finishes[0].agent.outcome, 'limited');
    finishes[0].release({ result: 'failed', message: '⚠️ #7: the agent hit its usage limit', silent: false });
    await runner.idle();
    assert.deepEqual(outboxEntries().map((e) => [e.replyTo, e.text]), [['owner', `${NOTICE} 0 requests queued.\n\n⚠️ #7: the agent hit its usage limit`]]);
  });

  it('an autofix pass that hits the limit pauses too, and the run ends limited', async () => {
    const { runner, starts, finishes, usageLimit, outboxEntries, history } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'jid-1' });
    starts[0].finish('success');
    await flush();
    const autofix = finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' });
    await flush();
    starts[1].hitLimit(LIMIT);
    assert.equal((await autofix).outcome, 'limited');
    assert.equal((await usageLimit.get())?.until, LIMIT.resetsAt);
    finishes[0].release({ result: 'pr_open', message: '⚠️ #7 — Fix it: merge blocked by the autofix pass — needs a look.', silent: false });
    await runner.idle();
    assert.deepEqual(outboxEntries().map((e) => e.replyTo), ['owner', 'jid-1']);
    assert.equal(history[0].outcome, 'limited');
  });

  it('an autofix pass never starts while the usage-limit pause is set, and the run ends limited', async () => {
    const { runner, starts, finishes, usageLimit, outboxEntries, history } = issueSetup();
    await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    starts[0].finish('success');
    await flush();
    await usageLimit.extend(LIMIT);
    assert.equal((await finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' })).outcome, 'limited');
    assert.equal(starts.length, 1, 'no autofix agent was started');
    finishes[0].release({ result: 'limited', message: '⏸ #7 — Fix it: the autofix pass hit the usage limit.', silent: false });
    await runner.idle();
    assert.deepEqual(outboxEntries().map((e) => [e.replyTo, e.text]), [['owner', '⏸ #7 — Fix it: the autofix pass hit the usage limit.']]);
    assert.equal(history[0].outcome, 'limited');
    assert.deepEqual(history[0].followUps, []);
  });

  it('after the pass hits the limit, no autofix starts, and owner still hears once', async () => {
    const { runner, starts, finishes, usageLimit, outboxEntries } = issueSetup();
    await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    starts[0].hitLimit(LIMIT);
    await flush();
    assert.equal((await finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' })).outcome, 'limited');
    assert.equal(starts.length, 1);
    assert.equal((await usageLimit.get())?.until, LIMIT.resetsAt);
    finishes[0].release({ result: 'limited', message: '⏸ #7: the agent hit its usage limit.', silent: false });
    await runner.idle();
    assert.deepEqual(outboxEntries().map((e) => [e.replyTo, e.text]), [['owner', `${NOTICE} 0 requests queued.\n\n⏸ #7: the agent hit its usage limit.`]]);
  });

  it('a manual request the limit stopped before it started goes back to the head of the queue, and runs after the reset', async () => {
    const { runner, starts, queue, outboxEntries, history, advance } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    await runner.handleCommand({ text: 'claude two', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT, 1);
    await runner.idle();
    assert.deepEqual((await queue.list()).map((q) => [q.label, q.replyTo, q.cmd]), [
      ['one', 'jid-1', { kind: 'freeform', prompt: 'one' }],
      ['two', 'jid-1', { kind: 'freeform', prompt: 'two' }],
    ]);
    assert.equal(history[0].outcome, 'limited');
    assert.deepEqual(outboxEntries().filter((e) => e.replyTo === 'owner').map((e) => e.text), [
      `${NOTICE} Re-queued "one" at the head of the queue. 2 requests queued.`,
    ]);
    assert.match(outboxEntries().find((e) => e.replyTo === 'jid-1')?.text ?? '', /usage limit\.\nLog: .*\nIt is back at the head of the queue, and runs again once the limit resets\.$/);

    advance(61 * 60_000);
    await runner.drainQueue();
    assert.equal(starts.length, 1, 'still paused before the reset');
    advance(61 * 60_000);
    await runner.drainQueue();
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['one', 'one']);
  });

  it('a Joplin request with no turns is re-queued as the same command', async () => {
    const { runner, starts, queue } = setup();
    await runner.handleCommand({ text: 'claude joplin:Plan', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT, 0);
    await runner.idle();
    assert.deepEqual((await queue.list()).map((q) => [q.label, q.cmd]), [['joplin:Plan', { kind: 'joplin', noteQuery: 'Plan' }]]);
  });

  it('a request the limit stopped mid-run (more than 1 turn) is reported, not re-queued', async () => {
    const { runner, starts, queue, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT, 2);
    await runner.idle();
    assert.equal(await queue.length(), 0);
    assert.deepEqual(outboxEntries().filter((e) => e.replyTo === 'owner').map((e) => e.text), [`${NOTICE} 0 requests queued.`]);
    assert.doesNotMatch(outboxEntries().find((e) => e.replyTo === 'jid-1')?.text ?? '', /queue/);
  });

  it('a manual issue run the limit stopped before it started is re-queued with its instructions', async () => {
    const { runner, starts, finishes, queue, outboxEntries } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7 add tests', replyTo: 'owner' });
    starts[0].hitLimit(LIMIT, 1);
    await flush();
    assert.equal(finishes[0].requeued, true, 'the report says it was re-queued');
    finishes[0].release({ result: 'limited', message: '⏸ #7: the agent hit its usage limit.', silent: false });
    await runner.idle();
    assert.deepEqual((await queue.list()).map((q) => [q.label, q.replyTo, q.cmd]), [
      ['issue a#7', 'owner', { kind: 'issue', issueNumber: 7, alias: 'a', extraInstructions: 'add tests' }],
    ]);
    assert.deepEqual(outboxEntries().map((e) => [e.replyTo, e.text]), [
      ['owner', `${NOTICE} Re-queued "issue a#7" at the head of the queue. 1 request queued.\n\n⏸ #7: the agent hit its usage limit.`],
    ]);
  });

  it('a cron issue run that ends limited is not queued, however few its turns', async () => {
    const { runner, starts, finishes, queue } = issueSetup();
    await runner.startIssueRun({ issueNumber: 7, alias: 'a', replyTo: 'owner', trigger: 'cron' });
    starts[0].hitLimit(LIMIT, 0);
    await flush();
    assert.equal(finishes[0].requeued, false);
    finishes[0].release({ result: 'limited', message: '⏸ #7: the agent hit its usage limit.', silent: false });
    await runner.idle();
    assert.equal(await queue.length(), 0);
  });

  it('an issue run whose autofix hits the limit is not re-queued', async () => {
    const { runner, starts, finishes, queue } = issueSetup();
    await runner.handleCommand({ text: 'claude issue:a:7', replyTo: 'jid-1' });
    starts[0].finish('success');
    await flush();
    const autofix = finishes[0].runAgent({ prompt: 'fix review', label: 'autofix' });
    await flush();
    starts[1].hitLimit(LIMIT, 0);
    await autofix;
    finishes[0].release({ result: 'pr_open', message: 'blocked', silent: false });
    await runner.idle();
    assert.equal(await queue.length(), 0);
  });

  it('claude:resume with no alias ends it early, with any pauses by hand, and the queue starts', async () => {
    const { runner, starts, usageLimit, queue } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    await runner.handleCommand({ text: 'claude two', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT);
    await runner.idle();
    assert.equal(starts.length, 1);

    assert.equal((await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' })).reply, 'Resumed: cleared the usage-limit pause.');
    await runner.idle();
    assert.equal(await usageLimit.get(), null);
    assert.deepEqual(starts.map((s) => s.opts.prompt), ['one', 'two']);
    assert.equal(await queue.length(), 0);

    starts[1].hitLimit(LIMIT);
    await runner.idle();
    await runner.handleCommand({ text: 'claude:pause 1h', replyTo: 'jid-1' });
    assert.equal((await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' })).reply, 'Resumed: cleared 1 pause and the usage-limit pause.');
    assert.equal((await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' })).reply, 'Nothing was paused.');
  });

  it('claude:resume <alias> leaves it in place', async () => {
    const { runner, starts, usageLimit } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    starts[0].hitLimit(LIMIT);
    await runner.idle();
    assert.equal((await runner.handleCommand({ text: 'claude:resume all', replyTo: 'jid-1' })).reply, 'There was no general pause.');
    assert.notEqual(await usageLimit.get(), null);
  });

  it('a second hit with an earlier reset does not shorten the pause', async () => {
    const { runner, starts, usageLimit, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude one', replyTo: 'jid-1' });
    // a longer pause set while the run was going
    await usageLimit.extend({ resetsAt: '2026-09-24T16:00:00.000Z', note: null, timeZone: 'Europe/London' });
    starts[0].hitLimit(LIMIT);
    await runner.idle();
    assert.equal((await usageLimit.get())?.until, '2026-09-24T16:00:00.000Z');
    assert.equal(outboxEntries().find((e) => e.replyTo === 'owner')?.text, '⏸ Usage limit hit: pausing agent runs until 17:00. 0 requests queued.');
  });
});

describe('runner: claude:more', () => {
  const row = (extra = {}) => ({
    runId: 'old-1',
    kind: 'freeform',
    label: 'fix the bot',
    workspaceRoot: '/home/u/Projects',
    startedAt: '2026-09-24T11:00:00.000Z',
    endedAt: '2026-09-24T11:50:00.000Z',
    outcome: 'success',
    sessionId: 'sess-old',
    ...extra,
  });
  const more = (runner, text = 'claude:more add tests') => runner.handleCommand({ text, replyTo: 'jid-1' });

  it('resumes the newest freeform run in its cwd, with no static preamble, and names the parent', async () => {
    const { runner, starts, history } = setup();
    history.push(row({ runId: 'old-0', sessionId: 'sess-0' }), row({ workspaceRoot: '/repos/a', inferredWorkspace: 'a' }));
    const { reply } = await more(runner);
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].opts.resume, { sessionId: 'sess-old' });
    assert.equal(starts[0].opts.cwd, '/repos/a');
    assert.equal(starts[0].opts.prompt, 'add tests');
    assert.equal(starts[0].opts.preamble, undefined);
    assert.match(reply, /^Started run run-1, continuing "fix the bot" \(10m00s ago\) in \/repos\/a/);
  });

  it('records the continuation: parent kind, label, parentRunId, inferred workspace', async () => {
    const { runner, starts, history, lock } = setup();
    history.push(row({ kind: 'joplin', label: 'Joplin note "Plan"', inferredWorkspace: 'a' }));
    await more(runner, 'claude:more   carry on\nplease');
    assert.deepEqual(
      { kind: (await lock.current()).kind, ws: (await lock.current()).inferredWorkspace },
      { kind: 'joplin', ws: 'a' }
    );
    starts[0].finish();
    await runner.idle();
    const h = history.at(-1);
    assert.equal(h.kind, 'joplin');
    assert.equal(h.label, '↪ carry on please');
    assert.equal(h.parentRunId, 'old-1');
    assert.equal(h.inferredWorkspace, 'a');
  });

  it('sends only the paused-workspaces note when a workspace is paused', async () => {
    const { runner, starts, history, manualPause } = setup();
    history.push(row());
    await manualPause.set({ scope: 'a', seconds: 3600, reason: 'by hand' });
    await more(runner);
    assert.match(starts[0].opts.preamble, /^The owner is working by hand in these workspaces[\s\S]*  - a: by hand$/);
    assert.ok(!starts[0].opts.preamble.includes('FREEFORM PREAMBLE'));
  });

  it('queues behind an active run and keeps the parent picked on submit', async () => {
    const { runner, starts, history, queue, outboxEntries, lock } = setup();
    history.push(row());
    await lock.tryAcquire({ runId: 'busy-1', kind: 'issue', label: 'issue a#7', workspaceRoot: '/repos/a' });
    const { reply } = await more(runner);
    assert.match(reply, /^Queued \(position 1\): ↪ add tests\./);
    assert.equal(/** @type {any} */ ((await queue.list())[0].cmd).parent.runId, 'old-1');
    await lock.release('busy-1');
    await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' });
    await runner.idle();
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].opts.resume, { sessionId: 'sess-old' });
    assert.match(outboxEntries().at(-1).text, /Queued request "↪ add tests": Started run/);
  });

  it('queues under the general pause and starts after the resume', async () => {
    const { runner, starts, history } = setup();
    history.push(row());
    await runner.handleCommand({ text: 'claude:pause 1h', replyTo: 'jid-1' });
    assert.match((await more(runner)).reply, /^Queued \(position 1\).*paused by hand/);
    assert.equal(starts.length, 0);
    await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' });
    await runner.idle();
    assert.equal(starts.length, 1);
    assert.equal(starts[0].opts.resume.sessionId, 'sess-old');
  });

  it('goes back to the head of the queue when the usage limit stops it before it starts', async () => {
    const { runner, starts, history, queue } = setup();
    history.push(row());
    await more(runner);
    starts[0].hitLimit({ resetsAt: '2026-09-24T15:02:00Z', note: null, timeZone: null }, 1);
    await runner.idle();
    const [item] = await queue.list();
    assert.equal(item.label, '↪ add tests');
    assert.equal(/** @type {any} */ (item.cmd).parent.sessionId, 'sess-old');
  });

  it('refuses in one line, starting nothing, with no parent, no session or no instructions', async () => {
    const { runner, starts, history } = setup();
    assert.equal((await more(runner)).reply, 'Nothing to continue: no freeform or Joplin run in history.');
    history.push(row({ kind: 'issue', label: 'issue a#1' }));
    assert.match((await more(runner)).reply, /^Nothing to continue/);
    history.push(row({ runId: 'old-2', sessionId: null }));
    assert.equal((await more(runner)).reply, 'Cannot continue "fix the bot": that run has no recorded session.');
    assert.match((await more(runner, 'claude:more')).reply, /^Usage: claude:more/);
    assert.equal(starts.length, 0);
  });
});

describe('runner: claude:more <run-id prefix>', () => {
  const row = (extra = {}) => ({
    runId: '2026-09-24T11-00-00-000Z',
    kind: 'freeform',
    label: 'fix the bot',
    workspaceRoot: '/repos/a',
    startedAt: '2026-09-24T11:00:00.000Z',
    endedAt: '2026-09-24T11:50:00.000Z',
    outcome: 'success',
    sessionId: 'sess-a',
    ...extra,
  });
  const more = (runner, text) => runner.handleCommand({ text, replyTo: 'jid-1' });

  it('continues the matching run, not the newest, with its kind, cwd, workspace and parentRunId', async () => {
    const { runner, starts, history } = setup();
    history.push(
      row({ kind: 'joplin', inferredWorkspace: 'a' }),
      row({ runId: '2026-09-25T09-00-00-000Z', workspaceRoot: '/repos/b', sessionId: 'sess-b' })
    );
    await more(runner, 'claude:more 2026-09-24 add tests');
    assert.deepEqual(starts[0].opts.resume, { sessionId: 'sess-a' });
    assert.equal(starts[0].opts.cwd, '/repos/a');
    assert.equal(starts[0].opts.prompt, 'add tests');
    starts[0].finish();
    await runner.idle();
    const h = history.at(-1);
    assert.deepEqual([h.kind, h.parentRunId, h.inferredWorkspace], ['joplin', '2026-09-24T11-00-00-000Z', 'a']);
  });

  it('continues a continuation, whose parentRunId is the immediate parent', async () => {
    const { runner, starts, history } = setup();
    history.push(row());
    await more(runner, 'claude:more 2026-09-24 first');
    starts[0].finish();
    await runner.idle();
    const childId = history.at(-1).runId;
    history.at(-1).sessionId = 'sess-child';
    await more(runner, `claude:more ${childId} second`);
    assert.deepEqual(starts[1].opts.resume, { sessionId: 'sess-child' });
    starts[1].finish();
    await runner.idle();
    assert.equal(history.at(-1).parentRunId, childId);
  });

  it('takes instructions that only start with a non-prefix word in full, continuing the newest', async () => {
    const { runner, starts, history } = setup();
    history.push(row());
    await more(runner, 'claude:more 2026 was a year');
    assert.equal(starts[0].opts.prompt, '2026 was a year');
  });

  it('refuses in one line, starting nothing: unknown, ambiguous, issue, job, no session', async () => {
    const { runner, starts, history } = setup();
    history.push(
      row({ runId: '2026-09-01T10-00-00-000Z' }),
      row({ runId: '2026-09-01T11-00-00-000Z' }),
      row({ runId: '2026-09-02T10-00-00-000Z', kind: 'issue', workspaceAlias: 'bot', issueNumber: 7 }),
      row({ runId: '2026-09-03T10-00-00-000Z', kind: 'job' }),
      row({ runId: '2026-09-04T10-00-00-000Z', sessionId: null })
    );
    const replies = [];
    for (const ref of ['2027-01', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) replies.push((await more(runner, `claude:more ${ref} go`)).reply);
    assert.match(replies[0], /^No run in history matches "2027-01"\.$/);
    assert.match(replies[1], /^Run prefix "2026-09-01" is ambiguous: it matches 2 runs\.$/);
    assert.match(replies[2], /claude issue:bot:7 <extra instructions>/);
    assert.match(replies[3], /scheduled job/);
    assert.match(replies[4], /no recorded session/);
    for (const r of replies) assert.ok(!r.includes('\n'));
    assert.equal(starts.length, 0);
  });
});

describe('runner: claude:more continues the active run', () => {
  const more = (runner, text = 'claude:more add tests') => runner.handleCommand({ text, replyTo: 'jid-1' });
  const oldRow = (extra = {}) => ({
    runId: '2026-09-20T11-00-00-000Z',
    kind: 'freeform',
    label: 'old run',
    workspaceRoot: '/repos/old',
    endedAt: '2026-09-20T11:50:00.000Z',
    outcome: 'success',
    sessionId: 'sess-old',
    ...extra,
  });

  it('queues behind the active freeform run, names it as the parent, and resumes its session when it ends', async () => {
    const { runner, starts, history, queue } = setup();
    history.push(oldRow());
    await runner.handleCommand({ text: 'claude fix the bot', replyTo: 'jid-0' });
    const { reply } = await more(runner);
    assert.match(reply, /^Continuing run run-1 \("fix the bot"\), which is still running\. Queued \(position 1\)/);
    assert.equal(/** @type {any} */ ((await queue.list())[0].cmd).parent.runId, 'run-1');
    starts[0].finish('success', 'done', 'sess-new');
    await runner.idle();
    assert.equal(starts.length, 2);
    assert.deepEqual(starts[1].opts.resume, { sessionId: 'sess-new' });
    assert.equal(starts[1].opts.prompt, 'add tests');
    starts[1].finish();
    await runner.idle();
    assert.equal(history.at(-1).parentRunId, 'run-1');
    assert.equal(history.at(-1).kind, 'freeform');
  });

  it('continues an active Joplin run with its kind and cwd, also when a run prefix matches it', async () => {
    const { runner, starts, history, lock } = setup({ newRunId: () => '2026-09-25T10-00-00-000Z' });
    history.push(oldRow());
    await runner.handleCommand({ text: 'claude joplin:Plan', replyTo: 'jid-0' });
    assert.match((await more(runner, 'claude:more 2026-09-25 carry on')).reply, /^Continuing run 2026-09-25T10-00-00-000Z/);
    starts[0].finish('success', 'done', 'sess-j');
    await runner.idle();
    assert.deepEqual(starts[1].opts.resume, { sessionId: 'sess-j' });
    assert.equal(starts[1].opts.cwd, '/home/u/Projects');
    assert.equal((await lock.current()).kind, 'joplin');
  });

  it('a run prefix that does not match the active run still picks from history', async () => {
    const { runner, starts, history } = setup();
    history.push(oldRow());
    await runner.handleCommand({ text: 'claude fix the bot', replyTo: 'jid-0' });
    const { reply } = await more(runner, 'claude:more 2026-09-20 go');
    assert.match(reply, /^Queued \(position 1\)/);
    starts[0].finish();
    await runner.idle();
    assert.deepEqual(starts[1].opts.resume, { sessionId: 'sess-old' });
    assert.equal(starts[1].opts.cwd, '/repos/old');
  });

  for (const [kind, extra] of /** @type {[string, object][]} */ ([['issue', { workspaceAlias: 'a', issueNumber: 7 }], ['job', { trigger: 'schedule' }]])) {
    it(`falls back to the newest freeform/Joplin history row while a ${kind} run is active`, async () => {
      const { runner, starts, history, lock } = setup();
      history.push(oldRow());
      await lock.tryAcquire({ runId: 'busy-1', kind, label: `a ${kind}`, workspaceRoot: '/repos/a', ...extra });
      const { reply } = await more(runner);
      assert.match(reply, /^Queued \(position 1\)/);
      assert.doesNotMatch(reply, /still running/);
      await lock.release('busy-1');
      await runner.handleCommand({ text: 'claude:resume', replyTo: 'jid-1' });
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(starts.at(-1).opts.resume, { sessionId: 'sess-old' });
      assert.equal(starts.at(-1).opts.cwd, '/repos/old');
    });
  }

  it('reports a clear failure and starts nothing when the parent ends without a session', async () => {
    const { runner, starts, history, outboxEntries } = setup();
    await runner.handleCommand({ text: 'claude fix the bot', replyTo: 'jid-0' });
    await more(runner);
    starts[0].finish('failed', '');
    await runner.idle();
    assert.equal(starts.length, 1);
    assert.match(outboxEntries().at(-1).text, /did not start: Cannot continue "fix the bot": that run has no recorded session\./);
    void history;
  });
});

describe('runner: claude:more adds to a queued Continuation of the same parent', () => {
  const row = (runId, extra = {}) => ({
    runId,
    kind: 'freeform',
    label: `run ${runId}`,
    workspaceRoot: '/repos/a',
    endedAt: '2026-09-24T11:50:00.000Z',
    outcome: 'success',
    sessionId: `sess-${runId}`,
    ...extra,
  });
  const say = (runner, text) => runner.handleCommand({ text, replyTo: 'jid-1' });

  it('merges a second message into the one queued request, in order, keeping its place', async () => {
    const { runner, starts, history, queue, lock } = setup();
    history.push(row('2026-09-02'), row('2026-09-01'));
    await lock.tryAcquire({ runId: 'busy-1', kind: 'issue', label: 'issue a#7', workspaceRoot: '/repos/a' });
    await say(runner, 'claude fix the other thing');
    await say(runner, 'claude:more 2026-09-01 first');
    await say(runner, 'claude fix a third thing');
    const { reply } = await say(runner, 'claude:more 2026-09-01 second');
    assert.match(reply, /^Added to the queued Continuation of run 2026-09-01 \(position 2\)/);
    const items = await queue.list();
    assert.equal(items.length, 3);
    assert.equal(items[1].cmd.kind, 'more');
    assert.equal(items[1].cmd.instructions, 'first\n\n---\n\nsecond');
    assert.match((await say(runner, 'claude:queue')).reply, /^Queued \(3\):/);
    await lock.release('busy-1');
    await say(runner, 'claude:resume');
    await runner.idle();
    starts[0].finish();
    await runner.idle();
    assert.equal(starts[1].opts.prompt, 'first\n\n---\n\nsecond');
  });

  it('queues messages for different parents separately', async () => {
    const { runner, history, queue, lock } = setup();
    history.push(row('2026-09-02'), row('2026-09-01'));
    await lock.tryAcquire({ runId: 'busy-1', kind: 'issue', label: 'issue a#7', workspaceRoot: '/repos/a' });
    await say(runner, 'claude:more 2026-09-01 one');
    assert.match((await say(runner, 'claude:more 2026-09-02 two')).reply, /^Queued \(position 2\)/);
    assert.equal((await queue.list()).length, 2);
  });
});
