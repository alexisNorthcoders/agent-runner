import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideSafeRestart, runSafeRestart } from '../src/safeRestart.js';
import { createRunLock } from '../src/runLock.js';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createMemoryStore } from './helpers/memoryStore.js';

describe('decideSafeRestart', () => {
  it('allows a restart when idle and not paused', () => {
    assert.deepEqual(decideSafeRestart({ activeRun: null, pause: null }), { ok: true });
  });

  it('refuses while a run is active, naming the run', () => {
    const d = decideSafeRestart({ activeRun: { runId: 'r1', label: 'freeform' }, pause: null });
    assert.equal(d.ok, false);
    assert.match(d.ok === false ? d.reason : '', /run r1 .*active/);
  });

  it('refuses while already paused (another restart in flight)', () => {
    const d = decideSafeRestart({ activeRun: null, pause: { token: 't', reason: 'safe-restart', pausedAt: 'x' } });
    assert.equal(d.ok, false);
    assert.match(d.ok === false ? d.reason : '', /paused/);
  });
});

function setup() {
  const store = createMemoryStore();
  const lock = createRunLock({ store, ttlSeconds: 60 });
  const pause = createPauseFlag({ store });
  /** @type {string[]} */
  const events = [];
  const deps = {
    lock,
    pause,
    restartProcess: async () => {
      events.push(`restart paused=${Boolean(await pause.get())}`);
    },
    waitForReady: async () => {
      events.push(`ready paused=${Boolean(await pause.get())}`);
    },
  };
  return { store, lock, pause, events, deps };
}

describe('runSafeRestart', () => {
  it('pauses, restarts, waits for the runner, then clears the pause', async () => {
    const { pause, events, deps } = setup();
    const r = await runSafeRestart(deps);
    assert.equal(r.ok, true);
    assert.deepEqual(events, ['restart paused=true', 'ready paused=true']);
    assert.equal(await pause.get(), null);
  });

  it('refuses without restarting or pausing while a run is active', async () => {
    const { lock, pause, events, deps } = setup();
    await lock.tryAcquire({ runId: 'r1' });
    const r = await runSafeRestart(deps);
    assert.equal(r.ok, false);
    assert.match(r.message, /refused.*r1/s);
    assert.deepEqual(events, []);
    assert.equal(await pause.get(), null);
  });

  it('refuses if a run grabs the lock between the check and the pause', async () => {
    const { lock, pause, events, deps } = setup();
    const realSet = pause.set;
    deps.pause = {
      ...pause,
      set: async (reason) => {
        await lock.tryAcquire({ runId: 'sneaky' });
        return realSet(reason);
      },
    };
    const r = await runSafeRestart(deps);
    assert.equal(r.ok, false);
    assert.match(r.message, /sneaky/);
    assert.deepEqual(events, []);
    assert.equal(await pause.get(), null);
  });

  it('does not touch a pause someone else set', async () => {
    const { pause, events, deps } = setup();
    const theirs = await pause.set('manual');
    const r = await runSafeRestart(deps);
    assert.equal(r.ok, false);
    assert.deepEqual(events, []);
    assert.equal((await pause.get())?.token, theirs);
  });

  it('clears its pause and reports failure when the runner does not come back', async () => {
    const { pause, deps } = setup();
    deps.waitForReady = async () => {
      throw new Error('no /status after 60s');
    };
    const r = await runSafeRestart(deps);
    assert.equal(r.ok, false);
    assert.match(r.message, /no \/status after 60s/);
    assert.equal(await pause.get(), null);
  });
});
