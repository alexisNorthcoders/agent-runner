import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as page from '../dashboard/format.js';
import * as cli from '../src/statusFormat.js';
import { formatRemaining } from '../src/manualPause.js';

describe('dashboard formatting matches agent:status', () => {
  it('formats durations, tokens, cost and models the same way', () => {
    for (const ms of [null, 0, 999, 59_000, 61_000, 3_599_000, 3_600_000, 90_061_000]) assert.equal(page.formatDuration(ms), cli.formatDuration(ms), String(ms));
    for (const n of [null, 0, 999, 1000, 9_999, 12_345, 999_999, 1_500_000]) assert.equal(page.formatTokens(n), cli.formatTokens(n), String(n));
    for (const usd of [null, 0, 0.126, 9.99, 12.34]) assert.equal(page.formatCost(usd), cli.formatCost(usd), String(usd));
    for (const m of [null, 'claude-haiku-4-5-20251001', 'claude-sonnet-5']) assert.equal(page.shortModel(m), cli.shortModel(m));
  });

  it('formats pause time left like claude:pause', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    for (const ms of [1, 60_000, 45 * 60_000, 80 * 60_000, 26 * 3_600_000]) {
      assert.equal(page.remaining(new Date(now + ms).toISOString(), now), formatRemaining(ms), String(ms));
    }
  });

  it('describes cron ticks in the same words', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const outcomes = [
      null,
      { kind: 'busy' },
      { kind: 'no_eligible' },
      { kind: 'ran', repo: 'o/r', issue: 3, result: 'progress' },
      { kind: 'ran', repo: 'o/r', issue: 3, result: 'failed', note: 'boom' },
      { kind: 'error', note: 'gh down' },
    ];
    for (const outcome of outcomes) {
      const text = cli.renderStatusText({
        now,
        active: [],
        paused: null,
        cron: { pid: 1, intervalMs: 1000, lastTickStartedAt: '2026-09-24T11:59:00Z', lastTickEndedAt: '2026-09-24T11:59:00Z', outcome },
        cronAlive: true,
        history: [],
      });
      assert.ok(text.includes(page.describeCronOutcome(outcome)), `${JSON.stringify(outcome)}: ${text}`);
    }
  });
});

describe('dashboard countdown clock', () => {
  it('shows minutes and seconds, and hours past an hour', () => {
    assert.equal(page.formatClock(0), '0:00');
    assert.equal(page.formatClock(-5), '0:00');
    assert.equal(page.formatClock(540_000), '9:00');
    assert.equal(page.formatClock(59_001), '1:00');
    assert.equal(page.formatClock(3_723_000), '1:02:03');
  });
});
