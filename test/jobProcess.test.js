import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { createJobLauncher } from '../src/jobProcess.js';

const CMD = 'echo out-1; echo err-1 >&2; echo out-2; echo "cwd=$(pwd) X=$X"; exit 3';

describe('job process', () => {
  it('appends stdout and stderr to the log exactly like `>> file 2>&1`', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-'));
    const ours = join(dir, 'logs', 'ours.log');
    const cron = join(dir, 'cron.log');
    const launcher = createJobLauncher();
    for (let i = 0; i < 2; i++) {
      const run = await launcher.start({ command: CMD, cwd: dir, logPath: ours, env: { X: 'y' }, timeoutMs: 10_000 });
      assert.equal(typeof run.pid, 'number');
      assert.deepEqual(await run.done, { outcome: 'failed', exitCode: 3, signal: null });
      await promisify(execFile)('sh', ['-c', `cd "${dir}" && X=y sh -c '${CMD.replace(/'/g, `'\\''`)}' >> "${cron}" 2>&1 || true`]);
    }
    const text = await readFile(ours, 'utf8');
    assert.equal(text, await readFile(cron, 'utf8'));
    assert.equal(text, `out-1\nerr-1\nout-2\ncwd=${dir} X=y\n`.repeat(2));
  });

  it('succeeds on exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-'));
    const run = await createJobLauncher().start({ command: 'true', cwd: dir, logPath: join(dir, 'l.log'), timeoutMs: 10_000 });
    assert.equal((await run.done).outcome, 'success');
  });

  it('stop kills the whole process group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-'));
    const run = await createJobLauncher().start({ command: 'sleep 30 & sleep 30; wait', cwd: dir, logPath: join(dir, 'l.log'), timeoutMs: 10_000 });
    run.stop();
    const r = await run.done;
    assert.equal(r.outcome, 'stopped');
    assert.equal(r.signal, 'SIGTERM');
    // the group's other members may take a moment to be reaped
    const groupAlive = () => {
      try {
        process.kill(-(/** @type {number} */ (run.pid)), 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && groupAlive(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(groupAlive(), false);
  });

  it('kills a command that runs past its timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-'));
    const run = await createJobLauncher().start({ command: 'sleep 30', cwd: dir, logPath: join(dir, 'l.log'), timeoutMs: 50 });
    assert.equal((await run.done).outcome, 'timeout');
  });

  it('a missing working directory is a spawn error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-'));
    const run = await createJobLauncher().start({ command: 'true', cwd: join(dir, 'nope'), logPath: join(dir, 'l.log'), timeoutMs: 10_000 });
    const r = await run.done;
    assert.equal(r.outcome, 'spawn_error');
    assert.match(r.error ?? '', /ENOENT/);
  });
});
