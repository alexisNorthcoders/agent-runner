import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRunHistory } from '../src/runHistory.js';

describe('runHistory', () => {
  it('appends one JSON line per finished run, creating the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'runs-'));
    try {
      const h = createRunHistory({ dir: join(dir, 'nested') });
      await h.append({ runId: 'a' });
      await h.append({ runId: 'b' });
      const lines = (await readFile(join(dir, 'nested', 'runs.jsonl'), 'utf8')).trim().split('\n');
      assert.deepEqual(lines.map((l) => JSON.parse(l).runId), ['a', 'b']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
