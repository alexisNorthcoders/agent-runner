import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRunHistory } from '../src/runHistory.js';

describe('runHistory', () => {
  /** @type {string} */
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runs-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('appends one JSON line per finished run, creating the directory', async () => {
    const h = createRunHistory({ dir: join(dir, 'nested') });
    await h.append({ runId: 'a' });
    await h.append({ runId: 'b' });
    const lines = (await readFile(join(dir, 'nested', 'runs.jsonl'), 'utf8')).trim().split('\n');
    assert.deepEqual(lines.map((l) => JSON.parse(l).runId), ['a', 'b']);
  });

  it('reads newest first, skipping torn lines, with limit and since', async () => {
    const h = createRunHistory({ dir });
    assert.deepEqual(await h.read(), []);
    await h.append({ runId: 'a', endedAt: '2026-01-01T00:00:00Z' });
    await appendFile(join(dir, 'runs.jsonl'), '{"runId":\n');
    await h.append({ runId: 'b', endedAt: '2026-01-02T00:00:00Z' });
    await h.append({ runId: 'c', endedAt: '2026-01-03T00:00:00Z' });
    assert.deepEqual((await h.read()).map((r) => r.runId), ['c', 'b', 'a']);
    assert.deepEqual((await h.read({ limit: 2 })).map((r) => r.runId), ['c', 'b']);
    const since = Date.parse('2026-01-02T00:00:00Z');
    assert.deepEqual((await h.read({ sinceMs: since })).map((r) => r.runId), ['c', 'b']);
  });
});
