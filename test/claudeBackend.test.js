import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createClaudeBackend } from '../src/agentBackend/claude.js';

const line = (o) => `${JSON.stringify(o)}\n`;

function fakeChild(pid = 4242) {
  const child = /** @type {any} */ (new EventEmitter());
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

/** Wait for queued stream 'data' events to be delivered. */
const tick = () => new Promise((r) => setImmediate(r));

describe('claude AgentBackend', () => {
  let dir;
  /** @type {any[]} */
  let spawned;
  /** @type {Array<[number, string]>} */
  let kills;
  let child;

  const backend = (opts = {}) =>
    createClaudeBackend({
      bin: '/bin/claude',
      model: 'sonnet',
      timeoutMs: 60_000,
      spawnFn: /** @type {any} */ ((bin, args, o) => {
        spawned.push({ bin, args, o });
        return child;
      }),
      killProcess: (c, sig) => kills.push([c.pid, sig]),
      ...opts,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agent-backend-'));
    spawned = [];
    kills = [];
    child = fakeChild();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('spawns the CLI headless with stream-json, the pinned model and the cwd', async () => {
    const run = await backend().start({ prompt: 'do it', cwd: '/w', logPath: join(dir, 'r.log') });
    assert.equal(run.pid, 4242);
    const { bin, args, o } = spawned[0];
    assert.equal(bin, '/bin/claude');
    assert.deepEqual(args.slice(0, -1), [
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ]);
    assert.equal(args.at(-1), 'do it');
    assert.equal(o.cwd, '/w');
    assert.equal(o.detached, true);
    child.emit('close', 0, null);
    await run.done;
  });

  it("uses the repo's own .claude settings model over the pinned one, local before shared", async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.claude'), { recursive: true });
    const b = backend();
    const modelFor = async () => {
      child = fakeChild();
      const run = await b.start({ prompt: 'P', cwd: repo, logPath: join(dir, 'm.log') });
      child.emit('close', 0, null);
      await run.done;
      const { args } = spawned.at(-1);
      return args[args.indexOf('--model') + 1];
    };

    assert.equal(await modelFor(), 'sonnet');
    await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }));
    assert.equal(await modelFor(), 'haiku');
    await writeFile(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ permissions: {} }));
    assert.equal(await modelFor(), 'haiku');
    await writeFile(join(repo, '.claude', 'settings.local.json'), JSON.stringify({ model: 'opus' }));
    assert.equal(await modelFor(), 'opus');
    await writeFile(join(repo, '.claude', 'settings.local.json'), '{ not json');
    assert.equal(await modelFor(), 'haiku');
  });

  it('passes a requested model over the repo settings, and reports the model and its source', async () => {
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.claude'), { recursive: true });
    const b = backend();
    const start = async (extra = {}) => {
      child = fakeChild();
      const run = await b.start({ prompt: 'P', cwd: repo, logPath: join(dir, 's.log'), ...extra });
      child.emit('close', 0, null);
      await run.done;
      const { args } = spawned.at(-1);
      return { arg: args[args.indexOf('--model') + 1], model: run.model };
    };
    assert.deepEqual(await start(), { arg: 'sonnet', model: { name: 'sonnet', source: 'default' } });
    await writeFile(join(repo, '.claude', 'settings.json'), JSON.stringify({ model: 'haiku' }));
    assert.deepEqual(await start(), { arg: 'haiku', model: { name: 'haiku', source: 'workspace' } });
    assert.deepEqual(await start({ model: 'opus' }), { arg: 'opus', model: { name: 'opus', source: 'prefix' } });
  });

  it('puts the preamble before the prompt, and /implement before everything for implement runs', async () => {
    const b = backend();
    let run = await b.start({ prompt: 'P', preamble: 'RULES', cwd: '/w', logPath: join(dir, 'a.log') });
    assert.equal(spawned[0].args.at(-1), 'RULES\n\n---\n\nP');
    child.emit('close', 0, null);
    await run.done;

    child = fakeChild();
    run = await b.start({ prompt: 'P', preamble: 'RULES', implement: true, cwd: '/w', logPath: join(dir, 'b.log') });
    assert.equal(spawned[1].args.at(-1), '/implement\n\nRULES\n\n---\n\nP');
    child.emit('close', 0, null);
    await run.done;
  });

  it('reports the final result text, usage and live progress', async () => {
    /** @type {any[]} */
    const progress = [];
    const logPath = join(dir, 'r.log');
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath, onProgress: (s) => progress.push(s) });
    child.stdout.write(line({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: 's' }));
    child.stdout.write(
      line({
        type: 'assistant',
        message: { id: 'm1', usage: { input_tokens: 3, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      })
    );
    await tick();
    child.stdout.write(line({ type: 'result', subtype: 'success', result: 'All good', total_cost_usd: 0.5, num_turns: 2 }));
    child.stderr.write('warn\n');
    await tick();
    child.emit('close', 0, null);
    const r = await run.done;
    assert.equal(r.outcome, 'success');
    assert.equal(r.text, 'All good');
    assert.equal(r.exitCode, 0);
    assert.equal(r.stderr, 'warn\n');
    assert.equal(r.usage.model, 'claude-sonnet-5');
    assert.equal(r.usage.costUsd, 0.5);
    assert.equal(r.usage.turns, 2);
    assert.ok(progress.some((p) => p.lastActivity === 'Bash: ls'));
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /→ Bash: ls/);
    assert.match(log, /\[err\] warn/);
    assert.match(log, /process end outcome=success/);
  });

  it('a non-zero exit is a failure', async () => {
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.emit('close', 1, null);
    const r = await run.done;
    assert.equal(r.outcome, 'failed');
    assert.equal(r.exitCode, 1);
  });

  it('stop() kills the process group and the outcome is "stopped"', async () => {
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    run.stop();
    assert.deepEqual(kills, [[4242, 'SIGTERM']]);
    child.emit('close', null, 'SIGTERM');
    const r = await run.done;
    assert.equal(r.outcome, 'stopped');
  });

  it('times out: kills the process and reports "timeout"', async () => {
    const run = await backend({ timeoutMs: 5 }).start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(kills[0], [4242, 'SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    assert.equal((await run.done).outcome, 'timeout');
  });

  // logs/agent-runs/2026-09-28T08-58-57-157Z.log: the agent finished, but its leftover Monitor
  // watchers kept the CLI alive, waking it for more turns until the timeout
  it('ends a CLI still running after its final result, with the outcome from that result', async () => {
    const logPath = join(dir, 'r.log');
    const run = await backend({ resultExitGraceMs: 5 }).start({ prompt: 'x', cwd: '/w', logPath });
    child.stdout.write(line({ type: 'result', subtype: 'success', result: 'Committed', total_cost_usd: 2.56, num_turns: 58 }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(kills[0], [4242, 'SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    const r = await run.done;
    assert.equal(r.outcome, 'success');
    assert.equal(r.text, 'Committed');
    assert.equal(r.usage.costUsd, 2.56);
    assert.match(await readFile(logPath, 'utf8'), /result received but the CLI is still running/);
  });

  it('an error result ended after the grace is a failure', async () => {
    const run = await backend({ resultExitGraceMs: 5 }).start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.stdout.write(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }));
    await new Promise((r) => setTimeout(r, 20));
    child.emit('close', null, 'SIGTERM');
    assert.equal((await run.done).outcome, 'failed');
  });

  it('a CLI that exits promptly after its result is not killed', async () => {
    const run = await backend({ resultExitGraceMs: 5 }).start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.stdout.write(line({ type: 'result', subtype: 'success', result: 'ok' }));
    await tick();
    child.emit('close', 0, null);
    assert.equal((await run.done).outcome, 'success');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(kills, []);
  });

  it('a timeout after the final result reports the result, not "timeout"', async () => {
    const run = await backend({ timeoutMs: 5 }).start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.stdout.write(line({ type: 'result', subtype: 'success', result: 'done' }));
    await new Promise((r) => setTimeout(r, 20));
    child.emit('close', null, 'SIGTERM');
    assert.equal((await run.done).outcome, 'success');
  });

  it('a stop after the final result stays stopped', async () => {
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.stdout.write(line({ type: 'result', subtype: 'success', result: 'done' }));
    await tick();
    run.stop();
    child.emit('close', null, 'SIGTERM');
    assert.equal((await run.done).outcome, 'stopped');
  });

  it('a spawn error (e.g. missing binary) resolves with a hint instead of throwing', async () => {
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.emit('error', Object.assign(new Error('spawn /bin/claude ENOENT'), { code: 'ENOENT' }));
    const r = await run.done;
    assert.equal(r.outcome, 'spawn_error');
    assert.match(r.stderr, /CLAUDE_AGENT_BIN/);
  });

  // Run logs keep only parsed lines, so the fixtures are rebuilt from real limited runs: the text
  // and turns from logs/agent-runs/2026-09-26T05-07-24-746Z.log, the rejected event's fields from a
  // limited session's transcript (`quotaLimits: { status: 'rejected', resetsAt }`).
  describe('the usage limit (fixtures rebuilt from real limited runs)', () => {
    /** @param {string} name @param {number} exitCode */
    async function runFixture(name, exitCode, now) {
      const run = await backend({ now: () => now }).start({ prompt: 'P', cwd: '/w', logPath: join(dir, 'l.log') });
      child.stdout.write(await readFile(new URL(`./fixtures/${name}`, import.meta.url)));
      await tick();
      child.emit('close', exitCode, null);
      return run.done;
    }

    it('ends with outcome limited and the reset time read from the text', async () => {
      const r = await runFixture('usage-limit-text.ndjson', 1, Date.parse('2026-09-26T05:07:24Z'));
      assert.equal(r.outcome, 'limited');
      assert.deepEqual(r.limit, { resetsAt: '2026-09-26T06:02:00.000Z', note: 'resets 7am Europe/London', timeZone: 'Europe/London' });
      assert.match(await readFile(join(dir, 'l.log'), 'utf8'), /process end outcome=limited exit=1/);
    });

    it("takes the reset from a rejected rate-limit event's epoch", async () => {
      const r = await runFixture('usage-limit-event.ndjson', 1, Date.parse('2026-09-16T00:08:40Z'));
      assert.equal(r.outcome, 'limited');
      assert.equal(r.limit?.resetsAt, '2026-09-16T00:12:00.000Z');
      assert.equal(r.limit?.note, 'resets 1:10am Europe/London');
    });

    it('is limited even if the CLI exits 0', async () => {
      const r = await runFixture('usage-limit-text.ndjson', 0, Date.parse('2026-09-26T05:07:24Z'));
      assert.equal(r.outcome, 'limited');
    });

    it('a successful run whose summary quotes the message is not limited', async () => {
      const run = await backend().start({ prompt: 'P', cwd: '/w', logPath: join(dir, 'q.log') });
      child.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: "You've hit your session limit is now handled." }));
      await tick();
      child.emit('close', 0, null);
      assert.equal((await run.done).outcome, 'success');
    });

    it('a failure that only quotes the message, with no rate-limit signal, is not limited', async () => {
      const run = await backend().start({ prompt: 'P', cwd: '/w', logPath: join(dir, 'g.log') });
      child.stdout.write(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: "You've hit your session limit · resets 7am (Europe/London)" }));
      await tick();
      child.emit('close', 1, null);
      const r = await run.done;
      assert.equal(r.outcome, 'failed');
      assert.equal(r.limit, undefined);
    });

    it('a normal failure has no limit', async () => {
      const run = await backend().start({ prompt: 'P', cwd: '/w', logPath: join(dir, 'f.log') });
      child.stdout.write(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }));
      await tick();
      child.emit('close', 1, null);
      const r = await run.done;
      assert.equal(r.outcome, 'failed');
      assert.equal(r.limit, undefined);
    });

    it('a stopped run stays stopped', async () => {
      const run = await backend().start({ prompt: 'P', cwd: '/w', logPath: join(dir, 's.log') });
      child.stdout.write(await readFile(new URL('./fixtures/usage-limit-text.ndjson', import.meta.url)));
      await tick();
      run.stop();
      child.emit('close', null, 'SIGTERM');
      assert.equal((await run.done).outcome, 'stopped');
    });
  });
});

describe('stopOrphanClaude', () => {
  const CMD = '/bin/claude -p --model sonnet --output-format stream-json --verbose --dangerously-skip-permissions do it';

  it('stops a leftover headless claude process group, escalating to SIGKILL', async () => {
    const { stopOrphanClaude } = await import('../src/agentBackend/claude.js');
    /** @type {string[]} */
    const signals = [];
    let aliveUntilKill = true;
    const gone = await stopOrphanClaude(77, {
      readCmdline: async () => CMD,
      kill: (_pid, sig) => {
        signals.push(sig);
        if (sig === 'SIGKILL') aliveUntilKill = false;
      },
      isAlive: () => aliveUntilKill,
      sleep: async () => {},
    });
    assert.equal(gone, true);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });

  it('leaves a recycled pid that is not an agent alone', async () => {
    const { stopOrphanClaude } = await import('../src/agentBackend/claude.js');
    let killed = false;
    const gone = await stopOrphanClaude(77, {
      readCmdline: async () => 'node server.js',
      kill: () => void (killed = true),
      isAlive: () => true,
      sleep: async () => {},
    });
    assert.equal(gone, false);
    assert.equal(killed, false);
  });
});

describe('read-only exploration session', () => {
  it('disables editing and shell tools by CLI flag, not just the prompt', async () => {
    const { createReadOnlySessionLauncher } = await import('../src/agentBackend/claude.js');
    let seen;
    const launch = createReadOnlySessionLauncher({
      bin: 'claude',
      execFileFn: /** @type {any} */ ((bin, args, opts, cb) => {
        seen = { bin, args, opts };
        cb(null, JSON.stringify({ result: 'idea' }), '');
      }),
    });
    assert.deepEqual(await launch({ cwd: '/ws/x', prompt: 'explore' }), { text: 'idea' });
    assert.equal(seen.opts.cwd, '/ws/x');
    assert.equal(seen.args[seen.args.indexOf('--tools') + 1], 'Read,Grep,Glob');
    const denied = seen.args[seen.args.indexOf('--disallowedTools') + 1].split(',');
    for (const t of ['Edit', 'Write', 'NotebookEdit', 'Bash']) assert.ok(denied.includes(t), t);
  });

  it('ends options before the prompt, so the variadic tool lists do not swallow it', async () => {
    const { readOnlySessionArgs } = await import('../src/agentBackend/claude.js');
    const args = readOnlySessionArgs({ prompt: 'explore', model: 'sonnet' });
    assert.deepEqual(args.slice(-2), ['--', 'explore']);
  });

  it('runs on Opus by default, whatever model other runs pin, unless REPO_INSIGHT_MODEL says otherwise', async () => {
    const { readOnlySessionArgs } = await import('../src/agentBackend/claude.js');
    const saved = { agent: process.env.CLAUDE_AGENT_MODEL, insight: process.env.REPO_INSIGHT_MODEL };
    try {
      process.env.CLAUDE_AGENT_MODEL = 'claude-sonnet-5-5';
      delete process.env.REPO_INSIGHT_MODEL;
      let args = readOnlySessionArgs({ prompt: 'p' });
      assert.equal(args[args.indexOf('--model') + 1], 'claude-opus-5-5');
      process.env.REPO_INSIGHT_MODEL = 'haiku';
      args = readOnlySessionArgs({ prompt: 'p' });
      assert.equal(args[args.indexOf('--model') + 1], 'haiku');
    } finally {
      for (const [k, v] of [['CLAUDE_AGENT_MODEL', saved.agent], ['REPO_INSIGHT_MODEL', saved.insight]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('closes stdin so the CLI does not wait for piped input', async () => {
    const { createReadOnlySessionLauncher } = await import('../src/agentBackend/claude.js');
    let ended = false;
    const launch = createReadOnlySessionLauncher({
      bin: 'claude',
      execFileFn: /** @type {any} */ ((_bin, _args, _opts, cb) => {
        setImmediate(() => cb(null, JSON.stringify({ result: 'idea' }), ''));
        return { stdin: { end: () => void (ended = true) } };
      }),
    });
    await launch({ cwd: '/ws/x', prompt: 'explore' });
    assert.equal(ended, true);
  });
});
