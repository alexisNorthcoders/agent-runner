import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from 'redis';
import { createRedisStore } from '../src/redisStore.js';
import { createMemoryStore } from './helpers/memoryStore.js';

/**
 * The same contract runs against the in-memory fake (used by every other test) and a real Redis,
 * so the fake cannot silently drift. The Redis half is skipped when no server is reachable.
 */

/** @param {() => { store: import('../src/redisStore.js').Store, readStream: (key: string) => Promise<Array<{ id: string, fields: Record<string, string> }>> }} setup */
function contract(setup) {
  const k = (name) => `agent-runner:test:${process.pid}:${name}`;

  it('setIfAbsent only sets a missing key', async () => {
    const { store } = setup();
    assert.equal(await store.setIfAbsent(k('a'), 'one', 60), true);
    assert.equal(await store.setIfAbsent(k('a'), 'two', 60), false);
    assert.equal(await store.get(k('a')), 'one');
  });

  it('replaceIfPresent only replaces an existing key', async () => {
    const { store } = setup();
    assert.equal(await store.replaceIfPresent(k('b'), 'x'), false);
    assert.equal(await store.get(k('b')), null);
    await store.setIfAbsent(k('b'), 'one', 60);
    assert.equal(await store.replaceIfPresent(k('b'), 'two'), true);
    assert.equal(await store.get(k('b')), 'two');
  });

  it('deleteIfField deletes only when the JSON field matches', async () => {
    const { store } = setup();
    await store.setIfAbsent(k('c'), JSON.stringify({ runId: 'r1', n: 1 }), 60);
    assert.equal(await store.deleteIfField(k('c'), 'runId', 'r2'), false);
    assert.notEqual(await store.get(k('c')), null);
    assert.equal(await store.deleteIfField(k('c'), 'runId', 'r1'), true);
    assert.equal(await store.get(k('c')), null);
    assert.equal(await store.deleteIfField(k('c'), 'runId', 'r1'), false);
  });

  it('del removes a key', async () => {
    const { store } = setup();
    await store.setIfAbsent(k('d'), 'v', 60);
    await store.del(k('d'));
    assert.equal(await store.get(k('d')), null);
  });

  it('set writes a value with no expiry, replacing any old one', async () => {
    const { store } = setup();
    await store.set(k('e'), 'one');
    await store.set(k('e'), 'two');
    assert.equal(await store.get(k('e')), 'two');
  });

  it('hashSet and hashGetAll keep one value per field', async () => {
    const { store } = setup();
    assert.deepEqual(await store.hashGetAll(k('h')), {});
    await store.hashSet(k('h'), 'a', '1');
    await store.hashSet(k('h'), 'b', '2');
    await store.hashSet(k('h'), 'a', '3');
    assert.deepEqual(await store.hashGetAll(k('h')), { a: '3', b: '2' });
    await store.hashDelete(k('h'), 'a');
    await store.hashDelete(k('h'), 'missing');
    assert.deepEqual(await store.hashGetAll(k('h')), { b: '2' });
    await store.del(k('h'));
    assert.deepEqual(await store.hashGetAll(k('h')), {});
  });

  it('appendToStream adds entries with a MINID trim', async () => {
    const { store, readStream } = setup();
    const key = k('stream');
    const now = Date.now();
    await store.appendToStream(key, { text: 'first' }, { minIdMs: now - 60_000 });
    const id = await store.appendToStream(key, { text: 'second' }, { minIdMs: now - 60_000 });
    assert.match(id, /^\d+-\d+$/);
    assert.deepEqual(
      (await readStream(key)).map((e) => e.fields.text),
      ['first', 'second']
    );
  });
}

describe('store contract: memory fake', () => {
  let mem;
  contract(() => {
    mem = createMemoryStore();
    return { store: mem, readStream: async (key) => mem.streams.get(key) ?? [] };
  });
});

describe('store contract: redis', async () => {
  /** @type {import('redis').RedisClientType} */
  let client;
  let reachable = false;
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  try {
    client = createClient({ url, socket: { connectTimeout: 500, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    await client.select(15);
    reachable = true;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    it('skipped: redis not reachable', { skip: true }, () => {});
    return;
  }

  const cleanup = async () => {
    const keys = await client.keys(`agent-runner:test:${process.pid}:*`);
    if (keys.length) await client.del(keys);
  };
  before(cleanup);
  after(async () => {
    await cleanup();
    await client.quit();
  });

  contract(() => ({
    store: createRedisStore(client),
    readStream: async (key) =>
      (await client.xRange(key, '-', '+')).map((e) => ({ id: e.id, fields: { ...e.message } })),
  }));
});
