import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createActiveRuns } from '../src/activeRuns.js';

const rec = (runId, extra = {}) => ({ runId, kind: 'freeform', label: 'job', startedAt: `2026-01-01T00:00:0${runId.length}Z`, ownerPid: 10, agentPid: 20, ...extra });

describe('activeRuns', () => {
  /** @type {string} */
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'active-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('publishes a run with its progress, and removes it on finish', async () => {
    const active = createActiveRuns({ dir, isAlive: () => true, throttleMs: 0 });
    const t = active.track(rec('r1'));
    await t.update({ model: 'm', turns: 3, outputTokens: 40, contextTokens: 900, lastActivity: 'Bash: ls' });
    const [run] = await active.list();
    assert.equal(run.runId, 'r1');
    assert.equal(run.turns, 3);
    assert.equal(run.lastActivity, 'Bash: ls');
    assert.equal(run.health, 'running');
    await t.finish();
    assert.deepEqual(await active.list(), []);
  });

  it('throttles progress writes but flushes the latest one afterwards', async () => {
    const active = createActiveRuns({ dir, isAlive: () => true, throttleMs: 30 });
    const t = active.track(rec('r1'));
    await t.update({ model: 'm', turns: 1, outputTokens: 0, contextTokens: 0, lastActivity: 'a' });
    await t.update({ model: 'm', turns: 2, outputTokens: 0, contextTokens: 0, lastActivity: 'b' });
    assert.equal((await active.list())[0].turns ?? 0, 0);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await active.list())[0].turns, 2);
    await t.finish();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await active.list(), [], 'a pending flush must not resurrect a finished run');
  });

  it('classifies health from the owner and agent pids', async () => {
    const t = createActiveRuns({ dir, isAlive: () => true, throttleMs: 0 });
    await t.track(rec('ok', { ownerPid: 1, agentPid: 2 })).ready;
    await t.track(rec('orphan', { ownerPid: 3, agentPid: 4 })).ready;
    await t.track(rec('dead', { ownerPid: 5, agentPid: 6 })).ready;
    const alive = new Set([1, 2, 4]);
    const runs = await createActiveRuns({ dir, isAlive: (pid) => alive.has(pid) }).list();
    assert.deepEqual(
      Object.fromEntries(runs.map((r) => [r.runId, r.health])),
      { ok: 'running', orphan: 'orphaned', dead: 'stale' }
    );
  });

  it('removeStale deletes only runs whose owner and agent are both gone', async () => {
    const w = createActiveRuns({ dir, isAlive: () => true, throttleMs: 0 });
    await w.track(rec('orphan', { ownerPid: 3, agentPid: 4 })).ready;
    await w.track(rec('dead', { ownerPid: 5, agentPid: 6 })).ready;
    const active = createActiveRuns({ dir, isAlive: (pid) => pid === 4 });
    assert.deepEqual(await active.removeStale(), ['dead']);
    assert.deepEqual((await active.list()).map((r) => r.runId), ['orphan']);
  });

  it('on startup, ownersGone ignores an owner pid that has been reused', async () => {
    const w = createActiveRuns({ dir, isAlive: () => true, throttleMs: 0 });
    await w.track(rec('old', { ownerPid: 3, agentPid: 4 })).ready;
    const active = createActiveRuns({ dir, isAlive: (pid) => pid === 3 });
    assert.deepEqual(await active.removeStale(), []);
    assert.deepEqual(await active.removeStale({ ownersGone: true }), ['old']);
  });

  it('is empty without a directory and skips corrupt files', async () => {
    assert.deepEqual(await createActiveRuns({ dir: join(dir, 'nope') }).list(), []);
    await mkdir(join(dir, 'active'), { recursive: true });
    await writeFile(join(dir, 'active', 'torn.json'), '{"runId":');
    assert.deepEqual(await createActiveRuns({ dir }).list(), []);
    assert.deepEqual(await readdir(join(dir, 'active')), ['torn.json']);
  });

  it('never throws when the directory cannot be written', async () => {
    await writeFile(join(dir, 'file'), 'x');
    const active = createActiveRuns({ dir: join(dir, 'file'), throttleMs: 0 });
    const t = active.track(rec('r1'));
    await t.ready;
    await t.update({ model: null, turns: 1, outputTokens: 0, contextTokens: 0, lastActivity: null });
    await t.finish();
  });
});
