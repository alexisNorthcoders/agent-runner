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

  it('a spawn error (e.g. missing binary) resolves with a hint instead of throwing', async () => {
    const run = await backend().start({ prompt: 'x', cwd: '/w', logPath: join(dir, 'r.log') });
    child.emit('error', Object.assign(new Error('spawn /bin/claude ENOENT'), { code: 'ENOENT' }));
    const r = await run.done;
    assert.equal(r.outcome, 'spawn_error');
    assert.match(r.stderr, /CLAUDE_AGENT_BIN/);
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
