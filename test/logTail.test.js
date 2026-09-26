import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogTail } from '../src/logTail.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {() => boolean} ok */
async function until(ok, ms = 1000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

describe('log tail', () => {
  /** @type {string} */
  let dir;
  /** @type {import('../src/logTail.js').ActiveLog | null} */
  let current;
  /** @type {ReturnType<typeof createLogTail> | null} */
  let tail;
  /** @type {{ runId: string | null, reset: boolean, lines: string[] }[]} */
  let events;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'logtail-'));
    current = null;
    events = [];
  });
  afterEach(async () => {
    tail?.stop();
    tail = null;
    await rm(dir, { recursive: true, force: true });
  });

  /** @param {Partial<Parameters<typeof createLogTail>[0]>} [opts] */
  function start(opts = {}) {
    tail = createLogTail({ current: () => current, pollMs: 10, ...opts });
    tail.onLines((e) => events.push(e));
    return tail.start();
  }

  it('starts from the last lines of the active run log, then streams new ones', async () => {
    const log = join(dir, 'r1.log');
    await writeFile(log, Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join(''));
    current = { runId: 'r1', logPath: log };
    await start({ tailLines: 3 });
    assert.deepEqual(tail?.tail(), { runId: 'r1', lines: ['line 7', 'line 8', 'line 9'] });
    await appendFile(log, 'line 10\nline 1');
    await until(() => events.some((e) => e.lines.includes('line 10')));
    await appendFile(log, '1\n');
    await until(() => events.some((e) => e.lines.includes('line 11')));
    assert.deepEqual(events.filter((e) => !e.reset).flatMap((e) => e.lines), ['line 10', 'line 11']);
    assert.deepEqual(tail?.tail().lines, ['line 9', 'line 10', 'line 11']);
  });

  it('masks secrets and caps long lines', async () => {
    const log = join(dir, 'r1.log');
    await writeFile(log, `GH_TOKEN=abc123 go\n${'x'.repeat(50)}\n`);
    current = { runId: 'r1', logPath: log };
    await start({ maxLineChars: 20 });
    const [masked, long] = tail?.tail().lines ?? [];
    assert.equal(masked, 'GH_TOKEN=*** go');
    assert.match(long, /^x{20}… \(30 more chars\)$/);
  });

  it('keeps the run tail across its autofix log, and resets for a new run', async () => {
    const first = join(dir, 'r1.log');
    await writeFile(first, 'agent\n');
    current = { runId: 'r1', logPath: first };
    await start();
    const autofix = join(dir, 'r1-autofix.log');
    await writeFile(autofix, 'fixing\n');
    current = { runId: 'r1', logPath: autofix };
    await until(() => events.some((e) => e.lines.includes('fixing')));
    assert.deepEqual(tail?.tail(), { runId: 'r1', lines: ['agent', 'fixing'] });
    assert.deepEqual(events.at(-1), { runId: 'r1', reset: true, lines: ['agent', 'fixing'] });

    const next = join(dir, 'r2.log');
    await writeFile(next, 'next run\n');
    current = { runId: 'r2', logPath: next };
    await until(() => events.some((e) => e.runId === 'r2'));
    assert.deepEqual(events.at(-1), { runId: 'r2', reset: true, lines: ['next run'] });
  });

  it('waits for a log that does not exist yet', async () => {
    const log = join(dir, 'r1.log');
    current = { runId: 'r1', logPath: log };
    await start();
    assert.deepEqual(tail?.tail(), { runId: 'r1', lines: [] });
    await writeFile(log, 'hello\n');
    await until(() => events.some((e) => e.lines.includes('hello')));
  });

  it('forgets the tail when the run ends, without telling listeners', async () => {
    const log = join(dir, 'r1.log');
    await writeFile(log, 'a\n');
    current = { runId: 'r1', logPath: log };
    await start();
    const before = events.length;
    current = null;
    await until(() => tail?.tail().runId === null);
    assert.deepEqual(tail?.tail().lines, []);
    await wait(30);
    assert.equal(events.length, before);
  });

  it('stops polling when stopped, and re-reads the tail on the next start', async () => {
    const log = join(dir, 'r1.log');
    await writeFile(log, 'a\n');
    current = { runId: 'r1', logPath: log };
    await start();
    tail?.stop();
    const before = events.length;
    await appendFile(log, 'b\n');
    await wait(50);
    assert.equal(events.length, before);
    await tail?.start();
    assert.deepEqual(tail?.tail().lines, ['a', 'b']);
  });

  it('starts a log other runs append to where this run began', async () => {
    const log = join(dir, 'job.log');
    const before = 'yesterday 1\nyesterday 2\n';
    await writeFile(log, `${before}today\n`);
    current = { runId: 'r1', logPath: log, fromByte: Buffer.byteLength(before) };
    await start();
    assert.deepEqual(tail?.tail().lines, ['today']);
  });

  it('drops the partial first line when the run began mid-line', async () => {
    const log = join(dir, 'job.log');
    await writeFile(log, 'yesterday 1\nhalf-written line\ntoday\n');
    current = { runId: 'r1', logPath: log, fromByte: Buffer.byteLength('yesterday 1\nhalf-') };
    await start();
    assert.deepEqual(tail?.tail().lines, ['today']);
  });
});

