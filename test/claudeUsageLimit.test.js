import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isUsageLimitText, usageLimitFrom, RESET_BUFFER_MS, FALLBACK_PAUSE_MS, MAX_PAUSE_MS } from '../src/agentBackend/claudeUsageLimit.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

describe('isUsageLimitText', () => {
  for (const text of [
    "You've hit your session limit · resets 7am (Europe/London)",
    "You've hit your weekly limit · resets Oct 3, 7am (Europe/London)",
    'You’ve hit your usage limit',
  ]) {
    it(`matches: ${text}`, () => assert.equal(isUsageLimitText(text), true));
  }
  for (const text of ['All done. I added a rate limit test.', "Done: a run that says You've hit your session limit now pauses.", 'Tests pass.', '']) {
    it(`leaves alone: ${JSON.stringify(text)}`, () => assert.equal(isUsageLimitText(text), false));
  }
});

describe('usageLimitFrom: the reset text', () => {
  const at = (s) => Date.parse(s);

  it('a time later today, in the zone, plus the buffer (BST)', () => {
    const now = at('2026-09-26T05:07:00Z'); // 06:07 BST
    const l = usageLimitFrom({ text: "You've hit your session limit · resets 7am (Europe/London)", now });
    assert.equal(l.resetsAt, iso(at('2026-09-26T06:00:00Z') + RESET_BUFFER_MS));
    assert.equal(l.note, 'resets 7am Europe/London');
    assert.equal(l.timeZone, 'Europe/London');
  });

  it('a time already passed today rolls to tomorrow', () => {
    const now = at('2026-09-26T08:30:00Z'); // 09:30 BST
    const l = usageLimitFrom({ text: 'hit your session limit · resets 7am (Europe/London)', now });
    assert.equal(l.resetsAt, iso(at('2026-09-27T06:00:00Z') + RESET_BUFFER_MS));
  });

  it('minutes and pm', () => {
    const now = at('2026-09-23T18:00:00Z'); // 19:00 BST
    const l = usageLimitFrom({ text: "You've hit your session limit · resets 11:10pm (Europe/London)", now });
    assert.equal(l.resetsAt, iso(at('2026-09-23T22:10:00Z') + RESET_BUFFER_MS));
  });

  it('12am is midnight and 12pm is noon', () => {
    const now = at('2026-01-10T09:00:00Z');
    assert.equal(usageLimitFrom({ text: 'hit your limit · resets 12pm (UTC)', now }).resetsAt, iso(at('2026-01-10T12:00:00Z') + RESET_BUFFER_MS));
    assert.equal(usageLimitFrom({ text: 'hit your limit · resets 12am (UTC)', now }).resetsAt, iso(at('2026-01-11T00:00:00Z') + RESET_BUFFER_MS));
  });

  it('a dated form', () => {
    const now = at('2026-09-29T12:00:00Z');
    const l = usageLimitFrom({ text: "You've hit your weekly limit · resets Oct 3, 7am (Europe/London)", now });
    assert.equal(l.resetsAt, iso(at('2026-10-03T06:00:00Z') + RESET_BUFFER_MS));
    assert.equal(l.note, 'resets Oct 3, 7am Europe/London');
  });

  it('a dated form in early January, said in late December, is next year', () => {
    const now = at('2026-12-30T12:00:00Z');
    const l = usageLimitFrom({ text: 'hit your weekly limit · resets Jan 2, 9:30am (Europe/London)', now });
    assert.equal(l.resetsAt, iso(at('2027-01-02T09:30:00Z') + RESET_BUFFER_MS));
  });

  it('across the autumn DST change: tomorrow 7am is GMT, not BST', () => {
    // 2026-10-25 01:00 UTC the clocks go back; it's 10:00 BST on the 24th
    const now = at('2026-10-24T09:00:00Z');
    const l = usageLimitFrom({ text: 'hit your session limit · resets 7am (Europe/London)', now });
    assert.equal(l.resetsAt, iso(at('2026-10-25T07:00:00Z') + RESET_BUFFER_MS));
  });

  it('across the spring DST change: tomorrow 7am is BST', () => {
    const now = at('2026-03-28T12:00:00Z');
    const l = usageLimitFrom({ text: 'hit your session limit · resets 7am (Europe/London)', now });
    assert.equal(l.resetsAt, iso(at('2026-03-29T06:00:00Z') + RESET_BUFFER_MS));
  });

  it('garbage text falls back to a 1h pause', () => {
    const now = at('2026-09-26T05:07:00Z');
    for (const text of ["You've hit your session limit", 'hit your limit · resets whenever (Europe/London)', 'hit your limit · resets 7am (Not/AZone)', 'hit your limit · resets 25pm (UTC)']) {
      const l = usageLimitFrom({ text, now });
      assert.equal(l.resetsAt, iso(now + FALLBACK_PAUSE_MS), text);
      assert.equal(l.timeZone, null, text);
    }
  });
});

describe('usageLimitFrom: the structured reset time', () => {
  const now = Date.parse('2026-09-16T00:08:40Z');

  it('wins over the text, epoch seconds or ms, and keeps the text as the note', () => {
    const epochS = 1789517400; // 2026-09-16T00:10:00Z
    const text = "You've hit your session limit · resets 1:10am (Europe/London)";
    const l = usageLimitFrom({ text, resetsAtEpoch: epochS, now });
    assert.equal(l.resetsAt, iso(epochS * 1000 + RESET_BUFFER_MS));
    assert.equal(l.note, 'resets 1:10am Europe/London');
    assert.equal(usageLimitFrom({ text: '', resetsAtEpoch: epochS * 1000, now }).resetsAt, iso(epochS * 1000 + RESET_BUFFER_MS));
  });

  it('is capped at 7 days', () => {
    const l = usageLimitFrom({ text: '', resetsAtEpoch: (now + 30 * 24 * HOUR) / 1000, now });
    assert.equal(l.resetsAt, iso(now + MAX_PAUSE_MS));
  });

  it('a reset already past pauses only for the buffer', () => {
    const l = usageLimitFrom({ text: '', resetsAtEpoch: (now - HOUR) / 1000, now });
    assert.equal(l.resetsAt, iso(now + RESET_BUFFER_MS));
  });
});
