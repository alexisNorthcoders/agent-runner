import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectStatus } from '../src/statusCollect.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

function deps(overrides = {}) {
  /** @type {any[]} */
  const reads = [];
  return {
    reads,
    deps: {
      activeRuns: { list: async () => [{ runId: 'a', health: /** @type {const} */ ('running') }] },
      history: {
        read: async (/** @type {any} */ opts) => {
          reads.push(opts);
          return [{ runId: 'h', endedAt: '2026-09-24T11:00:00Z', outcome: 'success' }];
        },
      },
      readCron: async () => ({ pid: 42, intervalMs: 1000, lastTickStartedAt: null, lastTickEndedAt: null, outcome: null }),
      readPause: async () => null,
      isAlive: (/** @type {number} */ pid) => pid === 42,
      now: () => NOW,
      ...overrides,
    },
  };
}

describe('collectStatus', () => {
  it('combines active runs, the last week of history, cron state and the pause flag', async () => {
    const { deps: d, reads } = deps();
    const s = await collectStatus(d);
    assert.equal(s.now, NOW);
    assert.deepEqual(s.active.map((r) => r.runId), ['a']);
    assert.deepEqual(s.history.map((r) => r.runId), ['h']);
    assert.deepEqual(reads, [{ sinceMs: NOW - 7 * 864e5 }]);
    assert.equal(s.cron?.pid, 42);
    assert.equal(s.cronAlive, true);
    assert.equal(s.paused, null);
  });

  it('reports the pause as unknown when Redis fails or hangs', async () => {
    const failing = await collectStatus(deps({ readPause: async () => { throw new Error('ECONNREFUSED'); } }).deps);
    assert.equal(failing.paused, 'unknown');
    const hanging = await collectStatus(deps({ readPause: () => new Promise(() => {}), pauseTimeoutMs: 10 }).deps);
    assert.equal(hanging.paused, 'unknown');
  });

  it('shows a lock holder that has no active file yet (e.g. mid Joplin fetch), without duplicating tracked runs', async () => {
    const lock = { runId: 'b', label: 'joplin:plan', startedAt: '2026-09-24T11:59:00Z', ownerPid: 42 };
    const s = await collectStatus(deps({ readLock: async () => lock }).deps);
    assert.deepEqual(s.active.map((r) => [r.runId, r.health]), [['a', 'running'], ['b', 'running']]);
    const same = await collectStatus(deps({ readLock: async () => ({ runId: 'a', ownerPid: 42 }) }).deps);
    assert.deepEqual(same.active.map((r) => r.runId), ['a']);
  });

  it('ignores a lock it cannot read', async () => {
    const s = await collectStatus(deps({ readLock: async () => { throw new Error('down'); } }).deps);
    assert.deepEqual(s.active.map((r) => r.runId), ['a']);
  });

  it('marks no cron as not alive', async () => {
    const s = await collectStatus(deps({ readCron: async () => null }).deps);
    assert.equal(s.cron, null);
    assert.equal(s.cronAlive, false);
  });
});
