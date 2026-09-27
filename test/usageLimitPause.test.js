import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageLimitPause, describeUsageLimitPause } from '../src/usageLimitPause.js';
import { createMemoryStore } from './helpers/memoryStore.js';

describe('usage-limit pause', () => {
  const setup = () => {
    let t = Date.parse('2026-09-26T05:10:00Z');
    const pause = createUsageLimitPause({ store: createMemoryStore(), now: () => t });
    return { pause, advance: (ms) => void (t += ms) };
  };

  it('is absent until set, then holds until its end time and expires on its own', async () => {
    const { pause, advance } = setup();
    assert.equal(await pause.get(), null);
    const { pause: p, extended } = await pause.extend({ resetsAt: '2026-09-26T06:02:00.000Z', note: 'resets 7am Europe/London', timeZone: 'Europe/London' });
    assert.equal(extended, true);
    assert.deepEqual(p, { until: '2026-09-26T06:02:00.000Z', note: 'resets 7am Europe/London', timeZone: 'Europe/London', since: '2026-09-26T05:10:00.000Z' });
    assert.deepEqual(await pause.get(), p);
    advance(52 * 60_000 - 1);
    assert.notEqual(await pause.get(), null);
    advance(1);
    assert.equal(await pause.get(), null);
  });

  it('only ever extends: an earlier reset leaves the later one in place', async () => {
    const { pause } = setup();
    await pause.extend({ resetsAt: '2026-09-26T06:02:00.000Z', note: 'resets 7am Europe/London', timeZone: 'Europe/London' });
    const r = await pause.extend({ resetsAt: '2026-09-26T05:40:00.000Z', note: null, timeZone: null });
    assert.equal(r.extended, false);
    assert.equal(r.pause.until, '2026-09-26T06:02:00.000Z');
    assert.equal((await pause.get())?.until, '2026-09-26T06:02:00.000Z');
    const later = await pause.extend({ resetsAt: '2026-09-26T07:00:00.000Z', note: null, timeZone: null });
    assert.equal(later.extended, true);
    assert.equal((await pause.get())?.until, '2026-09-26T07:00:00.000Z');
  });

  it('a reset already past sets nothing', async () => {
    const { pause } = setup();
    const r = await pause.extend({ resetsAt: '2026-09-26T05:00:00.000Z', note: null, timeZone: null });
    assert.equal(r.extended, false);
    assert.equal(await pause.get(), null);
  });

  it('describes itself in the zone the agent named', () => {
    const p = { until: '2026-09-26T06:02:00.000Z', note: 'resets 7am Europe/London', timeZone: 'Europe/London', since: '' };
    const now = Date.parse('2026-09-26T05:10:00Z');
    assert.equal(describeUsageLimitPause(p, now), 'until 07:02 (resets 7am Europe/London)');
    assert.equal(describeUsageLimitPause({ ...p, note: null, timeZone: 'UTC' }, now), 'until 06:02');
    const days = { ...p, until: '2026-09-29T06:02:00.000Z' };
    assert.equal(describeUsageLimitPause(days, now), 'until Tue 29 Sep 07:02 (resets 7am Europe/London)');
  });
});
