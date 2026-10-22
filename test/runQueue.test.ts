import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QUEUE_KEY, createRunQueue } from '../src/runQueue.ts';
import { createMemoryStore } from './helpers/memoryStore.ts';
import type { QueuedRun } from '../src/runQueue.ts';

const item = (id: string): QueuedRun => ({ id, cmd: { kind: 'freeform', prompt: id }, replyTo: 'jid', label: id, queuedAt: '2026-09-24T12:00:00.000Z' });

describe('runQueue parsing', () => {
  const parent = { runId: 'p', kind: 'freeform' as const, label: 'fix it', cwd: '/w' };
  const job = { name: 'nightly', room: 'r', cwd: '/w', command: 'npm run x', at: '04:00', env: { A: '1' }, timeoutMinutes: 5, weekday: 1 };
  const cmds: QueuedRun['cmd'][] = [
    { kind: 'freeform', prompt: 'p', model: 'opus' },
    { kind: 'joplin', noteQuery: 'plan' },
    { kind: 'more', instructions: 'more', parent: { ...parent, pending: true } },
    { kind: 'more', instructions: 'more', parent: { ...parent, sessionId: 's', endedAt: '2026-09-24T11:00:00.000Z', outcome: 'success', model: 'sonnet', inferredWorkspace: 'bot' }, model: 'haiku' },
    { kind: 'issue', issueNumber: 7, alias: null, extraInstructions: '' },
    { kind: 'issue', issueNumber: 7, alias: 'bot', extraInstructions: 'x' },
    { kind: 'job', job },
  ];

  it('reads back every kind of request the runner queues', async () => {
    const queue = createRunQueue({ store: createMemoryStore() });
    const items = cmds.map((cmd, i): QueuedRun => ({ ...item(String(i)), cmd }));
    for (const it of items) await queue.push(it);
    assert.deepEqual(await queue.list(), items);
  });

  it('skips an item whose request does not parse', async () => {
    const store = createMemoryStore();
    const queue = createRunQueue({ store });
    const torn = [
      { kind: 'more', instructions: 'x' },
      { kind: 'more', instructions: 'x', parent: { ...parent, kind: 'issue', pending: true } },
      { kind: 'job', job: { ...job, at: '25:00' } },
      { kind: 'issue', issueNumber: '7', alias: null, extraInstructions: '' },
      { kind: 'freeform' },
      { kind: 'unknown' },
    ];
    for (const cmd of torn) await store.listPushBack(QUEUE_KEY, JSON.stringify({ ...item('t'), cmd }));
    await store.listPushBack(QUEUE_KEY, JSON.stringify({ ...item('no-label'), label: undefined }));
    await queue.push(item('ok'));
    assert.deepEqual((await queue.list()).map((i) => i.id), ['ok']);
  });
});

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
