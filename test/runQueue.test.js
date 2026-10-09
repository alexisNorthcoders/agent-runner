import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunQueue } from '../src/runQueue.js';
import { createMemoryStore } from './helpers/memoryStore.js';

/** @param {string} id @returns {import('../src/runQueue.js').QueuedRun} */
const item = (id) => ({ id, cmd: { kind: 'freeform', prompt: id }, replyTo: 'jid', label: id, queuedAt: '2026-09-24T12:00:00.000Z' });

describe('runQueue.update', () => {
  it('rewrites a waiting item in place, keeping its position', async () => {
    const queue = createRunQueue({ store: createMemoryStore() });
    for (const id of ['a', 'b', 'c']) await queue.push(item(id));
    const r = await queue.update('b', (it) => ({ ...it, label: 'changed' }));
    assert.equal(r?.position, 2);
    assert.deepEqual((await queue.list()).map((i) => i.label), ['a', 'changed', 'c']);
  });

  it('returns null for an item that is not waiting', async () => {
    const queue = createRunQueue({ store: createMemoryStore() });
    await queue.push(item('a'));
    await queue.shift();
    assert.equal(await queue.update('a', (it) => it), null);
  });
});
