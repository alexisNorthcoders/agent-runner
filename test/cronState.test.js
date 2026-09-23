import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCronState, prAttemptStateKey } from '../src/cronState.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const REPO = 'alexisNorthcoders/WhatsappBot';

describe('cronState', () => {
  it('is null until the cron has started', async () => {
    assert.equal(await createCronState({ store: createMemoryStore() }).read(), null);
  });

  it('records the start, then the last tick with the writer pid and interval', async () => {
    const state = createCronState({ store: createMemoryStore(), now: () => Date.parse('2026-01-01T00:00:05Z') });
    await state.writeStarted({ intervalMs: 60_000 });
    assert.deepEqual(await state.read(), { pid: process.pid, intervalMs: 60_000, lastTickStartedAt: null, lastTickEndedAt: null, outcome: null });
    await state.writeTick({ outcome: { kind: 'no_eligible' }, intervalMs: 60_000, startedAt: Date.parse('2026-01-01T00:00:00Z') });
    assert.deepEqual(await state.read(), {
      pid: process.pid,
      intervalMs: 60_000,
      lastTickStartedAt: '2026-01-01T00:00:00.000Z',
      lastTickEndedAt: '2026-01-01T00:00:05.000Z',
      outcome: { kind: 'no_eligible' },
    });
  });

  it('reads an unparseable tick record as no state', async () => {
    const store = createMemoryStore();
    await store.set('agent-runner:cron:state', '{nope');
    assert.equal(await createCronState({ store }).read(), null);
  });

  it('keeps the last-started issue per repo, ignoring junk entries', async () => {
    const store = createMemoryStore();
    const state = createCronState({ store });
    assert.deepEqual(await state.lastStarted(), new Map());
    await state.setLastStarted(REPO, 7);
    await state.setLastStarted('o/platformer', 2);
    await state.setLastStarted(REPO, 9);
    await store.hashSet('agent-runner:cron:last-started', 'o/junk', 'x');
    assert.deepEqual(await state.lastStarted(), new Map([[REPO, 9], ['o/platformer', 2]]));
  });

  it('refuses to record a bad repo slug or issue number', async () => {
    const state = createCronState({ store: createMemoryStore() });
    await assert.rejects(state.setLastStarted('not a slug', 1), /invalid repo/);
    await assert.rejects(state.setLastStarted(REPO, 0), /invalid issue number/);
  });

  it('keeps the PR state last attempted per issue, and the one the owner was told about', async () => {
    const state = createCronState({ store: createMemoryStore() });
    await state.setPrAttempt(REPO, 39, 'h1:m1');
    await state.setPrAttempt(REPO, 39, 'h2:m1');
    assert.deepEqual(await state.prAttempts(), new Map([[`${REPO}#39`, 'h2:m1']]));
    assert.deepEqual(await state.parkNotices(), new Map());
    await state.setParkNotice(REPO, 39, 'h2:m1');
    assert.deepEqual(await state.parkNotices(), new Map([[`${REPO}#39`, 'h2:m1']]));
  });

  it('a PR state is its head commit plus the tip of its base branch', () => {
    assert.equal(prAttemptStateKey({ headSha: 'abc' }, 'def'), 'abc:def');
  });
});
