import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunLock } from '../src/runLock.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const run = (runId, extra = {}) => ({ runId, kind: 'freeform', replyTo: 'r', startedAt: 't', ...extra });

describe('runLock', () => {
  it('is single-flight: a second acquire fails while the first run holds it', async () => {
    const lock = createRunLock({ store: createMemoryStore(), ttlSeconds: 60 });
    assert.equal(await lock.tryAcquire(run('a')), true);
    assert.equal(await lock.tryAcquire(run('b')), false);
    assert.equal((await lock.current())?.runId, 'a');
  });

  it('release frees the lock only for the run that holds it', async () => {
    const lock = createRunLock({ store: createMemoryStore(), ttlSeconds: 60 });
    await lock.tryAcquire(run('a'));
    assert.equal(await lock.release('b'), false);
    assert.equal((await lock.current())?.runId, 'a');
    assert.equal(await lock.release('a'), true);
    assert.equal(await lock.current(), null);
    assert.equal(await lock.tryAcquire(run('b')), true);
  });

  it('update rewrites the holder record but not another run', async () => {
    const lock = createRunLock({ store: createMemoryStore(), ttlSeconds: 60 });
    await lock.tryAcquire(run('a'));
    assert.equal(await lock.update(run('a', { agentPid: 42 })), true);
    assert.equal((await lock.current())?.agentPid, 42);
    assert.equal(await lock.update(run('b', { agentPid: 7 })), false);
    assert.equal((await lock.current())?.runId, 'a');
  });

  it('update does not resurrect a released lock', async () => {
    const lock = createRunLock({ store: createMemoryStore(), ttlSeconds: 60 });
    await lock.tryAcquire(run('a'));
    await lock.release('a');
    assert.equal(await lock.update(run('a', { agentPid: 1 })), false);
    assert.equal(await lock.current(), null);
  });

  it('treats a corrupt lock value as held by an unknown run', async () => {
    const store = createMemoryStore();
    store.kv.set('agent-runner:lock', 'not json');
    const lock = createRunLock({ store, ttlSeconds: 60 });
    assert.deepEqual(await lock.current(), { runId: 'unknown' });
    assert.equal(await lock.tryAcquire(run('a')), false);
  });

  it('forceClear removes whatever holds the lock', async () => {
    const lock = createRunLock({ store: createMemoryStore(), ttlSeconds: 60 });
    await lock.tryAcquire(run('a'));
    await lock.forceClear();
    assert.equal(await lock.current(), null);
  });
});
