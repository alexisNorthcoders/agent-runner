import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, OWNER, OUTBOX_KEY } from '../src/outbox.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const DAY = 24 * 60 * 60 * 1000;

describe('outbox', () => {
  it('XADDs {replyTo, text, runId, ts} to agent-runner:outbox', async () => {
    const store = createMemoryStore();
    const now = Date.UTC(2026, 8, 23, 12);
    const outbox = createOutbox({ store, now: () => now });
    const id = await outbox.send({ replyTo: '4479@s.whatsapp.net', text: 'done', runId: 'run-1' });
    const entries = store.streams.get(OUTBOX_KEY);
    assert.equal(OUTBOX_KEY, 'agent-runner:outbox');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, id);
    assert.deepEqual(entries[0].fields, {
      replyTo: '4479@s.whatsapp.net',
      text: 'done',
      runId: 'run-1',
      ts: new Date(now).toISOString(),
    });
  });

  it('writes an empty runId for messages not tied to a run, and owner is the system recipient', async () => {
    const store = createMemoryStore();
    await createOutbox({ store }).send({ replyTo: OWNER, text: 'hello' });
    assert.equal(OWNER, 'owner');
    assert.deepEqual(
      { ...store.streams.get(OUTBOX_KEY)[0].fields, ts: undefined },
      { replyTo: 'owner', text: 'hello', runId: '', ts: undefined }
    );
  });

  it('trims entries older than ~7 days on every write', async () => {
    /** @type {any[]} */
    const calls = [];
    const store = { ...createMemoryStore(), appendToStream: async (key, fields, opts) => (calls.push({ key, opts }), '1-0') };
    const now = 30 * DAY;
    await createOutbox({ store, now: () => now }).send({ replyTo: OWNER, text: 'x' });
    assert.deepEqual(calls, [{ key: OUTBOX_KEY, opts: { minIdMs: now - 7 * DAY } }]);
  });

  it('refuses an empty replyTo', async () => {
    await assert.rejects(createOutbox({ store: createMemoryStore() }).send({ replyTo: '', text: 'x' }), /replyTo/);
  });
});
