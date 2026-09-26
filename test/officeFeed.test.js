import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createOfficeFeed } from '../src/officeFeed.js';
import { createStateChanges } from '../src/stateChanges.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A feed behind a real HTTP server, and a reader that collects the SSE events it receives. */
async function setup(opts = {}) {
  const changes = createStateChanges();
  let n = 0;
  const feed = createOfficeFeed({
    snapshot: async () => /** @type {any} */ ({ version: 1, n: ++n }),
    subscribe: changes.subscribe,
    coalesceMs: 20,
    minIntervalMs: 60,
    heartbeatMs: 10_000,
    logger: { warn() {} },
    ...opts,
  });
  const server = createServer((req, res) => feed.attach(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const port = /** @type {import('net').AddressInfo} */ (server.address()).port;
  /** @type {AbortController[]} */
  const readers = [];

  async function connect() {
    const ac = new AbortController();
    readers.push(ac);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
    /** @type {{ event: string, data: any }[]} */
    const events = [];
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for await (const chunk of /** @type {any} */ (res.body)) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data != null) events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return { res, events, close: () => ac.abort() };
  }

  return {
    feed,
    changes,
    connect,
    async stop() {
      for (const r of readers) r.abort();
      feed.close();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}

/** @param {() => boolean} ok */
async function until(ok, ms = 1000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

describe('office feed', () => {
  /** @type {Awaited<ReturnType<typeof setup>> | null} */
  let t = null;
  afterEach(async () => {
    await t?.stop();
    t = null;
  });

  it('is an unbuffered event stream that starts with a full snapshot', async () => {
    t = await setup();
    const c = await t.connect();
    assert.equal(c.res.status, 200);
    assert.match(c.res.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(c.res.headers.get('x-accel-buffering'), 'no');
    await until(() => c.events.length === 1);
    assert.deepEqual(c.events[0], { event: 'snapshot', data: { version: 1, n: 1 } });
  });

  it('pushes one new snapshot to every client for a burst of changes', async () => {
    t = await setup();
    const a = await t.connect();
    const b = await t.connect();
    await until(() => a.events.length === 1 && b.events.length === 1);
    t.changes.notify('progress');
    t.changes.notify('phase');
    t.changes.notify('agent-runner:lock');
    await until(() => a.events.length === 2 && b.events.length === 2);
    await wait(100);
    assert.equal(a.events.length, 2);
    assert.deepEqual(a.events[1].data, b.events[1].data);
  });

  it('keeps pushing while changes keep coming, at most once per minimum interval', async () => {
    t = await setup();
    const c = await t.connect();
    await until(() => c.events.length === 1);
    const start = Date.now();
    const timer = setInterval(() => t?.changes.notify('progress'), 5);
    await wait(250);
    clearInterval(timer);
    const pushes = c.events.length - 1;
    assert.ok(pushes >= 2, `pushed ${pushes} times`);
    assert.ok(pushes <= Math.ceil((Date.now() - start) / 60) + 1, `pushed ${pushes} times`);
  });

  it('builds nothing while nobody is connected, and forgets a client that disconnects', async () => {
    /** @type {number} */
    let builds = 0;
    t = await setup({ snapshot: async () => ({ n: ++builds }) });
    t.changes.notify('queue');
    await wait(50);
    assert.equal(builds, 0);
    const c = await t.connect();
    await until(() => t?.feed.clients() === 1 && c.events.length === 1);
    c.close();
    await until(() => t?.feed.clients() === 0);
    t.changes.notify('queue');
    await wait(100);
    assert.equal(builds, 1);
  });

  it('resends the snapshot on a slow heartbeat, which also keeps proxies from timing out', async () => {
    t = await setup({ heartbeatMs: 40 });
    const c = await t.connect();
    await until(() => c.events.length >= 3);
  });

  it('survives a snapshot that fails to build', async () => {
    let fail = false;
    t = await setup({ snapshot: async () => {
      if (fail) throw new Error('disk');
      return { ok: true };
    } });
    const c = await t.connect();
    await until(() => c.events.length === 1);
    fail = true;
    t.changes.notify('x');
    await wait(100);
    fail = false;
    t.changes.notify('x');
    await until(() => c.events.length === 2);
  });

  it('never sends a client an older snapshot after a newer one', async () => {
    /** @type {{ n: number, release: () => void }[]} */
    const builds = [];
    let n = 0;
    t = await setup({
      snapshot: () => {
        const b = { n: ++n, release: () => {} };
        builds.push(b);
        return new Promise((r) => (b.release = () => r({ n: b.n })));
      },
    });
    const a = await t.connect();
    await until(() => builds.length === 1);
    builds[0].release();
    await until(() => a.events.length === 1);
    t.changes.notify('progress'); // build 2, held back
    await until(() => builds.length === 2);
    const b = await t.connect(); // build 3
    await until(() => builds.length === 3);
    builds[2].release();
    await until(() => b.events.length === 1);
    builds[1].release();
    await until(() => a.events.length === 2);
    await wait(50);
    assert.deepEqual(a.events.map((e) => e.data.n), [1, 2]);
    assert.deepEqual(b.events.map((e) => e.data.n), [3]);
  });

  it('refuses clients over the limit', async () => {
    t = await setup({ maxClients: 1 });
    const a = await t.connect();
    await until(() => a.events.length === 1);
    const b = await t.connect();
    assert.equal(b.res.status, 503);
  });
});
