import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createManualPause, formatRemaining, parseDuration } from '../src/manualPause.js';
import { createMemoryStore } from './helpers/memoryStore.js';

describe('manual pause', () => {
  it('lists live pauses, the general one first, and forgets expired ones', async () => {
    let t = Date.parse('2026-09-26T04:00:00Z');
    const mp = createManualPause({ store: createMemoryStore(), now: () => t });
    await mp.set({ scope: 'snake', seconds: 600 });
    await mp.set({ scope: 'all', seconds: 3600, reason: 'working on agent-runner' });
    await mp.set({ scope: 'bot', seconds: 7200 });
    assert.deepEqual((await mp.list()).map((p) => p.scope), ['all', 'bot', 'snake']);
    assert.equal((await mp.general())?.reason, 'working on agent-runner');
    t += 11 * 60_000;
    assert.equal(await mp.forWorkspace('snake'), null);
    assert.deepEqual((await mp.list()).map((p) => p.scope), ['all', 'bot']);
    assert.equal(await mp.clearAll(), 2);
    assert.equal(await mp.general(), null);
  });

  it('parses and formats durations', () => {
    assert.equal(parseDuration('45m'), 2700);
    assert.equal(parseDuration('2H'), 7200);
    assert.equal(parseDuration('0h'), null);
    assert.equal(parseDuration('soon'), null);
    assert.equal(formatRemaining(80 * 60_000), '1h20m');
    assert.equal(formatRemaining(27 * 3600_000), '1d3h');
    assert.equal(formatRemaining(10_000), '1m');
  });
});
