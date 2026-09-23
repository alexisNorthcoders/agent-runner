import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJoplinClient } from '../src/joplin.js';

/** Fake Joplin Data API: routes by path, records every URL requested. */
function fakeApi({ folders, notes, bodies }) {
  /** @type {URL[]} */
  const calls = [];
  const fetchFn = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    const page = Number(u.searchParams.get('page') || '1');
    if (u.pathname === '/folders') {
      // two pages to exercise pagination
      return json(page === 1 ? { items: folders.slice(0, 1), has_more: folders.length > 1 } : { items: folders.slice(1), has_more: false });
    }
    const m = u.pathname.match(/^\/folders\/([^/]+)\/notes$/);
    if (m) return json({ items: notes[m[1]] ?? [], has_more: false });
    const n = u.pathname.match(/^\/notes\/([^/]+)$/);
    if (n) return bodies[n[1]] ? json(bodies[n[1]]) : json({ error: 'Not Found' }, 404);
    return json({ error: 'Not Found' }, 404);
  };
  return { calls, fetchFn };
}

const api = () =>
  fakeApi({
    folders: [
      { id: 'f-other', title: 'Personal' },
      { id: 'f-bot', title: 'WhatsApp Bot' },
    ],
    notes: {
      'f-bot': [
        { id: 'aaa111', title: 'Refactor plan v2' },
        { id: 'bbb222', title: 'refactor plan' },
      ],
      'f-other': [{ id: 'ccc333', title: 'secret' }],
    },
    bodies: {
      aaa111: { id: 'aaa111', title: 'Refactor plan v2', body: 'v2 body', parent_id: 'f-bot' },
      bbb222: { id: 'bbb222', title: 'refactor plan', body: 'plan body', parent_id: 'f-bot' },
      ccc333: { id: 'ccc333', title: 'secret', body: 'nope', parent_id: 'f-other' },
    },
  });

const client = (fetchFn, extra = {}) =>
  createJoplinClient({ baseUrl: 'http://127.0.0.1:41184', token: 'T', notebook: 'WhatsApp Bot', fetchFn, ...extra });

describe('joplin Data API client', () => {
  it('prefers an exact (case-insensitive) title match inside the notebook, sending the token', async () => {
    const { calls, fetchFn } = api();
    const note = await client(fetchFn).getNote('Refactor Plan');
    assert.deepEqual(note, { id: 'bbb222', title: 'refactor plan', body: 'plan body' });
    assert.ok(calls.every((u) => u.searchParams.get('token') === 'T'));
  });

  it('falls back to a partial title match', async () => {
    const { fetchFn } = api();
    assert.equal((await client(fetchFn).getNote('v2')).id, 'aaa111');
  });

  it('accepts a note id or id prefix, but only within the notebook', async () => {
    const { fetchFn } = api();
    assert.equal((await client(fetchFn).getNote('aaa1')).body, 'v2 body');
    await assert.rejects(client(fetchFn).getNote('ccc333'), /No Joplin note matching "ccc333" in notebook "WhatsApp Bot"/);
  });

  it('errors clearly when the notebook does not exist', async () => {
    const { fetchFn } = api();
    await assert.rejects(client(fetchFn, { notebook: 'Nope' }).getNote('x'), /notebook "Nope" not found/);
  });

  it('errors clearly without a token', async () => {
    const { fetchFn } = api();
    await assert.rejects(client(fetchFn, { token: '' }).getNote('x'), /JOPLIN_API_TOKEN/);
  });

  it('explains an unreachable API', async () => {
    const fetchFn = async () => {
      throw new TypeError('fetch failed');
    };
    await assert.rejects(client(fetchFn).getNote('x'), /Joplin Data API unreachable at http:\/\/127\.0\.0\.1:41184/);
  });
});
