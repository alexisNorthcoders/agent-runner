import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_READ_BYTES, TAIL_BYTES, createSessionWatch } from '../src/sessionWatch.js';

const T0 = Date.parse('2026-10-06T10:00:00Z');
const MIN = 60_000;
const iso = (ms) => new Date(T0 + ms).toISOString();

const entry = (ms, sessionId, cwd, extra) => JSON.stringify({ sessionId, cwd, gitBranch: 'main', entrypoint: 'cli', isSidechain: false, timestamp: iso(ms), ...extra });
const prompt = (ms, id, cwd, extra) => entry(ms, id, cwd, { type: 'user', message: { content: 'hi' }, ...extra });
const tool = (ms, id, cwd, command) => entry(ms, id, cwd, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const reply = (ms, id, cwd) => entry(ms, id, cwd, { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } });

/** A fake filesystem of transcripts: path → { text, mtimeMs }, counting the bytes read. */
function fakeFs() {
  /** @type {Map<string, { buf: Buffer, mtimeMs: number }>} */
  const files = new Map();
  const reads = [];
  return {
    files,
    reads,
    write(path, text, mtimeMs) {
      files.set(path, { buf: Buffer.from(text), mtimeMs });
    },
    append(path, text, mtimeMs) {
      const f = files.get(path);
      files.set(path, { buf: Buffer.concat([f?.buf ?? Buffer.alloc(0), Buffer.from(text)]), mtimeMs });
    },
    list: async () => [...files].map(([path, f]) => ({ path, size: f.buf.length, mtimeMs: f.mtimeMs })),
    read: async (path, start, end) => {
      reads.push([path, start, end]);
      return files.get(path).buf.subarray(start, end);
    },
  };
}

const WS = [
  { alias: 'bot', root: '/p/bot' },
  { alias: 'chess', root: '/p/chess' },
];

function setup({ cwds = ['/p/bot'], workspaces = WS } = {}) {
  const fs = fakeFs();
  let t = T0;
  const state = { cwds, changes: [] };
  const watch = createSessionWatch({
    root: '/projects',
    workspaces: { list: async () => workspaces },
    claudeCwds: async () => state.cwds,
    fs,
    realpath: async (p) => p,
    now: () => t,
    onChange: (r) => state.changes.push(r),
    logger: { info() {}, warn() {} },
  });
  return { fs, watch, state, at: (ms) => (t = T0 + ms) };
}

describe('session watch', () => {
  it('lists interactive sessions in two workspaces with their state, following working and waiting', async () => {
    const { fs, watch, state, at } = setup({ cwds: ['/p/bot', '/p/chess'] });
    fs.write('/projects/a/s1.jsonl', `${prompt(0, 's1', '/p/bot')}\n${tool(1000, 's1', '/p/bot', 'npm test')}\n`, T0);
    fs.write('/projects/b/s2.jsonl', `${prompt(500, 's2', '/p/chess')}\n${reply(900, 's2', '/p/chess')}\n`, T0);
    at(2000);
    await watch.poll();
    const [a, b] = watch.current();
    assert.deepEqual([a.id, a.workspaceAlias, a.state, a.activity, a.branch, a.cwd], ['s1', 'bot', 'working', 'Bash: npm test', 'main', '/p/bot']);
    assert.deepEqual([b.id, b.workspaceAlias, b.state], ['s2', 'chess', 'waiting']);
    assert.equal(a.since, iso(2000));
    assert.equal(a.lastEntryAt, iso(1000));
    assert.deepEqual(state.changes, ['sessions']);
    // Claude finishes: the state follows within one poll
    fs.append('/projects/a/s1.jsonl', `${reply(5000, 's1', '/p/bot')}\n`, T0 + 5000);
    at(6000);
    await watch.poll();
    assert.equal(watch.current()[0].state, 'waiting');
    assert.equal(watch.current()[0].since, iso(2000));
    assert.equal(state.changes.length, 2);
    // nothing changed: no notification
    at(9000);
    await watch.poll();
    assert.equal(state.changes.length, 2);
  });

  it('never lists a headless run, and puts a session outside every workspace at null', async () => {
    const { fs, watch } = setup({ cwds: ['/p/bot', '/elsewhere'] });
    fs.write('/projects/a/h.jsonl', `${prompt(0, 'h', '/p/bot', { entrypoint: 'sdk-cli' })}\n`, T0);
    fs.write('/projects/c/o.jsonl', `${prompt(0, 'o', '/elsewhere')}\n`, T0);
    await watch.poll();
    assert.deepEqual(watch.current().map((s) => [s.id, s.workspaceAlias]), [['o', null]]);
  });

  it('matches the deepest workspace root', async () => {
    const w2 = setup({ cwds: ['/p/bot/sub/x'], workspaces: [...WS, { alias: 'sub', root: '/p/bot/sub' }] });
    w2.fs.write('/projects/a/s.jsonl', `${prompt(0, 's', '/p/bot/sub/x')}\n`, T0);
    await w2.watch.poll();
    assert.equal(w2.watch.current()[0].workspaceAlias, 'sub');
  });

  it('keeps a session visible without a process in its cwd, and drops it after the active window without writes', async () => {
    const { fs, watch, state, at } = setup();
    fs.write('/projects/a/s1.jsonl', `${prompt(0, 's1', '/p/bot')}\n`, T0);
    await watch.poll();
    assert.equal(watch.current().length, 1);
    state.cwds = [];
    at(3000);
    await watch.poll();
    assert.equal(watch.current().length, 1);
    at(11 * MIN);
    await watch.poll();
    assert.deepEqual(watch.current(), []);
  });

  it('keeps a transcript that starts headless and later has interactive entries', async () => {
    const { fs, watch } = setup();
    fs.write('/projects/a/m.jsonl', `${prompt(0, 'm', '/p/bot', { entrypoint: 'sdk-cli' })}\n${prompt(1000, 'm', '/p/bot')}\n`, T0 + 1000);
    await watch.poll();
    assert.deepEqual(watch.current().map((s) => s.id), ['m']);
  });

  it('counts one session per process in a directory, the most recently written', async () => {
    const { fs, watch } = setup();
    fs.write('/projects/a/old.jsonl', `${prompt(0, 'old', '/p/bot')}\n`, T0);
    fs.write('/projects/a/new.jsonl', `${prompt(60_000, 'new', '/p/bot')}\n`, T0 + 60_000);
    await watch.poll();
    assert.deepEqual(watch.current().map((s) => s.id), ['new']);
  });

  it('reads only the bytes appended since the last poll, and keeps a partial last line', async () => {
    const { fs, watch, at } = setup();
    const a = `${prompt(0, 's1', '/p/bot')}\n`;
    fs.write('/projects/a/s1.jsonl', a, T0);
    await watch.poll();
    assert.deepEqual(fs.reads, [['/projects/a/s1.jsonl', 0, a.length]]);
    const line = tool(1000, 's1', '/p/bot', 'ls');
    fs.append('/projects/a/s1.jsonl', line.slice(0, 30), T0 + 1000);
    at(2000);
    await watch.poll();
    assert.equal(watch.current()[0].activity, 'writing…');
    fs.append('/projects/a/s1.jsonl', `${line.slice(30)}\n`, T0 + 2000);
    at(3000);
    await watch.poll();
    assert.equal(watch.current()[0].activity, 'Bash: ls');
    assert.deepEqual(fs.reads.at(-1), ['/projects/a/s1.jsonl', a.length + 30, a.length + line.length + 1]);
    // no growth: not opened again
    const n = fs.reads.length;
    at(4000);
    await watch.poll();
    assert.equal(fs.reads.length, n);
  });

  it('reads a file seen for the first time from its tail only, and skips the cut line', async () => {
    const { fs, watch } = setup();
    const filler = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`.repeat(200);
    const text = `${filler}${prompt(0, 's1', '/p/bot')}\n${tool(1000, 's1', '/p/bot', 'npm test')}\n`;
    fs.write('/projects/a/s1.jsonl', text, T0);
    await watch.poll();
    const [, start, end] = fs.reads[0];
    assert.equal(end - start, TAIL_BYTES);
    assert.equal(end, Buffer.byteLength(text));
    assert.equal(watch.current()[0].activity, 'Bash: npm test');
  });

  it('jumps to the tail when a file grew by more than it will catch up on', async () => {
    const { fs, watch, at } = setup();
    fs.write('/projects/a/s1.jsonl', `${prompt(0, 's1', '/p/bot')}\n`, T0);
    await watch.poll();
    const big = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1000) } })}\n`.repeat(Math.ceil(MAX_READ_BYTES / 1000) + 5);
    fs.append('/projects/a/s1.jsonl', `${big}${reply(5000, 's1', '/p/bot')}\n`, T0 + 5000);
    at(6000);
    await watch.poll();
    const [, start, end] = fs.reads.at(-1);
    assert.equal(end - start, TAIL_BYTES);
    assert.equal(watch.current()[0].state, 'waiting');
  });

  it('starts a truncated or replaced file again from the beginning', async () => {
    const { fs, watch, at } = setup();
    fs.write('/projects/a/s1.jsonl', `${prompt(0, 's1', '/p/bot')}\n${tool(1000, 's1', '/p/bot', 'a very long command to make this file longer')}\n`, T0);
    await watch.poll();
    const fresh = `${reply(3000, 's1', '/p/bot')}\n`;
    fs.write('/projects/a/s1.jsonl', fresh, T0 + 3000);
    at(4000);
    await watch.poll();
    assert.deepEqual(fs.reads.at(-1), ['/projects/a/s1.jsonl', 0, fresh.length]);
    assert.equal(watch.current()[0].state, 'waiting');
  });

  it("opens no transcript that hasn't been written lately", async () => {
    const { fs, watch } = setup();
    fs.write('/projects/a/old.jsonl', `${prompt(0, 'old', '/p/bot')}\n`, T0 - 60 * MIN);
    await watch.poll();
    assert.deepEqual(fs.reads, []);
  });

  it('leaves no sessions, and keeps polling, when the transcripts cannot be listed', async () => {
    const { fs, watch, at } = setup();
    fs.write('/projects/a/s1.jsonl', `${prompt(0, 's1', '/p/bot')}\n`, T0);
    await watch.poll();
    const list = fs.list;
    fs.list = async () => {
      throw new Error('ENOENT');
    };
    await watch.poll();
    assert.deepEqual(watch.current(), []);
    fs.list = list;
    at(3000);
    await watch.poll();
    assert.equal(watch.current().length, 1);
  });
});
