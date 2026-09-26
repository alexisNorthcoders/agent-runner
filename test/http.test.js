import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/http.js';

describe('http API', () => {
  /** @type {any[]} */
  const commands = [];
  let failNext = false;
  const runner = {
    async handleCommand(req) {
      if (failNext) {
        failNext = false;
        throw new Error('redis down');
      }
      commands.push(req);
      return { reply: `got ${req.text}` };
    },
    async status() {
      return { busy: false, activeRun: null, paused: false, queued: 0 };
    },
  };
  /** @type {import('http').Server} */
  let server;
  let base;

  before(async () => {
    server = createHttpServer({ runner, logger: { error() {} } });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
    const addr = /** @type {import('net').AddressInfo} */ (server.address());
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(() => new Promise((r) => server.close(() => r(undefined))));

  const post = (body, raw = false) =>
    fetch(`${base}/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });

  it('POST /command passes {text, replyTo} to the runner and returns {reply}', async () => {
    const res = await post({ text: 'claude hi', replyTo: 'jid' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { reply: 'got claude hi' });
    assert.deepEqual(commands.at(-1), { text: 'claude hi', replyTo: 'jid' });
  });

  it('400s on missing fields or bad JSON', async () => {
    let res = await post({ text: 'claude hi' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).reply, /replyTo/);
    res = await post('{nope', true);
    assert.equal(res.status, 400);
  });

  it('500s with a reply when the runner throws', async () => {
    failNext = true;
    const res = await post({ text: 'claude hi', replyTo: 'jid' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).reply, /redis down/);
  });

  it('GET /status returns the runner status', async () => {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { busy: false, activeRun: null, paused: false, queued: 0 });
  });

  it('404s anything else', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/command`)).status, 404);
  });
});
