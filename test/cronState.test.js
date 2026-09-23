import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readCronState, writeCronTick } from '../src/cronState.js';

describe('cronState', () => {
  /** @type {string} */
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cron-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('is null until the cron has written a tick', async () => {
    assert.equal(await readCronState({ dir }), null);
  });

  it('round-trips the last tick with the writer pid and interval', async () => {
    await writeCronTick({
      dir,
      outcome: { kind: 'no_eligible' },
      intervalMs: 60_000,
      startedAt: Date.parse('2026-01-01T00:00:00Z'),
      now: () => Date.parse('2026-01-01T00:00:05Z'),
    });
    assert.deepEqual(await readCronState({ dir }), {
      pid: process.pid,
      intervalMs: 60_000,
      lastTickStartedAt: '2026-01-01T00:00:00.000Z',
      lastTickEndedAt: '2026-01-01T00:00:05.000Z',
      outcome: { kind: 'no_eligible' },
    });
  });
});
