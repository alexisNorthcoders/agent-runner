import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPauseFlag } from '../src/pauseFlag.js';
import { createMemoryStore } from './helpers/memoryStore.js';

describe('pauseFlag', () => {
  it('set returns a token and get reports the pause', async () => {
    const pause = createPauseFlag({ store: createMemoryStore(), now: () => 0 });
    const token = await pause.set('safe-restart');
    assert.equal(typeof token, 'string');
    assert.deepEqual(await pause.get(), { token, reason: 'safe-restart', pausedAt: new Date(0).toISOString() });
  });

  it('will not overwrite an existing pause', async () => {
    const pause = createPauseFlag({ store: createMemoryStore() });
    assert.ok(await pause.set('first'));
    assert.equal(await pause.set('second'), null);
    assert.equal((await pause.get())?.reason, 'first');
  });

  it('clear only removes a pause with the matching token', async () => {
    const pause = createPauseFlag({ store: createMemoryStore() });
    const token = await pause.set('mine');
    assert.equal(await pause.clear('someone-else'), false);
    assert.ok(await pause.get());
    assert.equal(await pause.clear(token), true);
    assert.equal(await pause.get(), null);
  });

  it('reports an unreadable pause value as paused', async () => {
    const store = createMemoryStore();
    store.kv.set('agent-runner:paused', '???');
    const pause = createPauseFlag({ store });
    assert.deepEqual(await pause.get(), { token: null, reason: 'unknown', pausedAt: null });
  });
});
