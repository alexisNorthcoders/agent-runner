import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStateChanges, notifyingStore } from '../src/stateChanges.js';
import { createMemoryStore } from './helpers/memoryStore.js';
import { createRunLock } from '../src/runLock.js';
import { createRunQueue } from '../src/runQueue.js';
import { createManualPause } from '../src/manualPause.js';
import { createOutbox } from '../src/outbox.js';

describe('state changes', () => {
  it('tells every subscriber, with the reason, until it unsubscribes', () => {
    const changes = createStateChanges();
    /** @type {string[]} */
    const a = [];
    /** @type {string[]} */
    const b = [];
    const offA = changes.subscribe((r) => a.push(r));
    changes.subscribe((r) => b.push(r));
    changes.notify('progress');
    offA();
    changes.notify('phase');
    assert.deepEqual(a, ['progress']);
    assert.deepEqual(b, ['progress', 'phase']);
  });

  it('keeps notifying the others when a subscriber throws', () => {
    const changes = createStateChanges({ logger: { warn() {} } });
    /** @type {string[]} */
    const seen = [];
    changes.subscribe(() => {
      throw new Error('boom');
    });
    changes.subscribe((r) => seen.push(r));
    changes.notify('queue');
    assert.deepEqual(seen, ['queue']);
  });
});

describe('notifyingStore', () => {
  function setup() {
    const changes = createStateChanges();
    /** @type {string[]} */
    const seen = [];
    changes.subscribe((r) => seen.push(r));
    const store = notifyingStore(createMemoryStore(), changes.notify);
    return { store, seen };
  }

  it('notifies after each state write, with the key', async () => {
    const { store, seen } = setup();
    const lock = createRunLock({ store, ttlSeconds: 60 });
    await lock.tryAcquire({ runId: 'r1' });
    await lock.update({ runId: 'r1', agentPid: 5 });
    await lock.release('r1');
    const queue = createRunQueue({ store });
    await queue.push({ id: 'q', cmd: { kind: 'freeform', prompt: 'hi' }, replyTo: 'x', label: 'hi', queuedAt: '' });
    await queue.shift();
    const pauses = createManualPause({ store });
    await pauses.set({ scope: 'all', seconds: 60 });
    assert.deepEqual(seen, [
      'agent-runner:lock',
      'agent-runner:lock',
      'agent-runner:lock',
      'agent-runner:queue',
      'agent-runner:queue',
      'agent-runner:manual-pause',
    ]);
  });

  it('stays quiet on reads, failed writes and the outbox', async () => {
    const { store, seen } = setup();
    const lock = createRunLock({ store, ttlSeconds: 60 });
    await lock.current();
    await lock.tryAcquire({ runId: 'r1' });
    seen.length = 0;
    assert.equal(await lock.tryAcquire({ runId: 'r2' }), false);
    assert.equal(await lock.release('r2'), false);
    await createOutbox({ store }).send({ replyTo: 'owner', text: 'hi' });
    await createRunQueue({ store }).list();
    assert.deepEqual(seen, []);
  });
});
