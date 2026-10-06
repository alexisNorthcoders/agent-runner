import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPO_INSIGHT_CURSOR_KEY,
  REPO_INSIGHT_PRIORITY as ORDER,
  createRepoInsightCursor,
  pickNextIdleWorkspace as pick,
} from '../src/repoInsight.js';
import { createMemoryStore } from './helpers/memoryStore.js';

const allIdle = Object.fromEntries(ORDER.map((a) => [a, true]));
const only = (...aliases) => Object.fromEntries(ORDER.map((a) => [a, aliases.includes(a)]));

describe('pickNextIdleWorkspace', () => {
  it('has the fixed 12-workspace order', () => {
    assert.equal(ORDER.length, 12);
    assert.equal(ORDER[0], 'bot');
    assert.equal(ORDER[11], 'dots');
  });

  it('starts at the top without a cursor', () => {
    assert.equal(pick(ORDER, allIdle, null), 'bot');
  });

  it('picks the workspace just after the cursor, wherever it sits', () => {
    ORDER.slice(0, -1).forEach((alias, i) => assert.equal(pick(ORDER, allIdle, alias), ORDER[i + 1]));
  });

  it('wraps from the last entry to the first', () => {
    assert.equal(pick(ORDER, allIdle, 'dots'), 'bot');
  });

  it('skips non-idle workspaces', () => {
    assert.equal(pick(ORDER, only('go-server', 'dots'), 'agent-runner'), 'go-server');
  });

  it('wraps past the end while skipping', () => {
    assert.equal(pick(ORDER, only('chess-trainer'), 'platformer'), 'chess-trainer');
  });

  it('picks the cursor itself when it is the only idle workspace', () => {
    assert.equal(pick(ORDER, only('snake-lab'), 'snake-lab'), 'snake-lab');
  });

  it('returns null when nothing is idle', () => {
    assert.equal(pick(ORDER, only(), 'bot'), null);
    assert.equal(pick(ORDER, {}, null), null);
  });

  it('treats an unknown cursor as no cursor, and accepts a Map', () => {
    assert.equal(pick(ORDER, allIdle, 'gone'), 'bot');
    assert.equal(pick(ORDER, new Map([['dots', true]]), 'bot'), 'dots');
  });
});

describe('repo insight cursor', () => {
  it('is null until written', async () => {
    assert.equal(await createRepoInsightCursor({ store: createMemoryStore() }).read(), null);
  });

  it('round-trips the alias under its own key', async () => {
    const store = createMemoryStore();
    const cursor = createRepoInsightCursor({ store });
    await cursor.write('platformer');
    assert.equal(await cursor.read(), 'platformer');
    assert.equal(await store.get(REPO_INSIGHT_CURSOR_KEY), 'platformer');
    await cursor.write('dots');
    assert.equal(await cursor.read(), 'dots');
  });

  it('refuses an empty alias', async () => {
    await assert.rejects(createRepoInsightCursor({ store: createMemoryStore() }).write(''), TypeError);
  });
});
