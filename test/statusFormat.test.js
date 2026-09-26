import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCost,
  formatDuration,
  formatTokens,
  renderHistoryLines,
  renderHistoryText,
  renderStatus,
  renderStatusText,
  shortModel,
} from '../src/statusFormat.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const tokens = (output, input = 0) => ({ input, output, cacheRead: 1000, cacheCreate: 0 });
/** @param {object} [extra] */
const row = (extra = {}) => ({
  runId: 'r1',
  kind: 'freeform',
  label: 'list the repos',
  startedAt: ago(15 * MIN),
  endedAt: ago(10 * MIN),
  durationMs: 5 * MIN,
  outcome: 'success',
  model: 'claude-opus-5-5',
  turns: 7,
  costUsd: 0.42,
  tokens: tokens(2000),
  ...extra,
});

/** @param {object} [extra] */
const snapshot = (extra = {}) => ({
  now: NOW,
  active: [],
  paused: null,
  cron: null,
  cronAlive: false,
  history: [],
  ...extra,
});

describe('status formatting helpers', () => {
  it('formats durations, tokens, costs and model names compactly', () => {
    assert.equal(formatDuration(42_000), '42s');
    assert.equal(formatDuration(3 * MIN + 5_000), '3m05s');
    assert.equal(formatDuration(125 * MIN), '2h05m');
    assert.equal(formatDuration(undefined), '-');
    assert.equal(formatTokens(950), '950');
    assert.equal(formatTokens(1234), '1.2k');
    assert.equal(formatTokens(56_000), '56k');
    assert.equal(formatTokens(2_300_000), '2.3M');
    assert.equal(formatCost(0.4213), '$0.42');
    assert.equal(formatCost(null), '-');
    assert.equal(shortModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  });
});

describe('renderStatusText (WhatsApp)', () => {
  it('shows idle, not paused, no cron, and no recent runs', () => {
    const text = renderStatusText(snapshot());
    assert.match(text, /^Agent: idle$/m);
    assert.match(text, /^Paused: no$/m);
    assert.match(text, /^Cron: not started/m);
    assert.match(text, /no finished runs/);
  });

  it('shows the active run with elapsed time, progress and phase', () => {
    const text = renderStatusText(
      snapshot({
        active: [{ runId: 'r9', label: 'fix the tests', startedAt: ago(3 * MIN), turns: 12, outputTokens: 4200, health: 'running', lastActivity: 'Bash: npm test' }],
      })
    );
    assert.match(text, /^Agent: fix the tests \(running, 3m00s, 12 turns, 4\.2k out tok\)$/m);
    assert.match(text, /^Phase: Bash: npm test$/m);
  });

  it('flags orphaned and stale runs', () => {
    const text = renderStatusText(
      snapshot({
        active: [
          { runId: 'o', label: 'a', startedAt: ago(MIN), agentPid: 77, health: 'orphaned', lastActivity: 'x' },
          { runId: 's', label: 'b', startedAt: ago(MIN), health: 'stale' },
        ],
      })
    );
    assert.match(text, /Orphaned.*pid 77/);
    assert.match(text, /Stale/);
    assert.doesNotMatch(text, /Phase:/);
  });

  it('shows the pause reason, or unknown when Redis is unreachable', () => {
    assert.match(renderStatusText(snapshot({ paused: { reason: 'safe-restart', pausedAt: ago(MIN), token: 't' } })), /^Paused: yes \(safe-restart, 1m00s ago\)$/m);
    assert.match(renderStatusText(snapshot({ paused: 'unknown' })), /^Paused: unknown \(Redis unreachable\)$/m);
  });

  it('shows the last cron tick, and says so when the cron process is gone', () => {
    const cron = { pid: 5, intervalMs: 30 * MIN, lastTickStartedAt: ago(6 * MIN), lastTickEndedAt: ago(5 * MIN), outcome: { kind: 'ran', repo: 'bot', issue: 12, result: 'progress' } };
    assert.match(renderStatusText(snapshot({ cron, cronAlive: true })), /^Cron: last tick 5m00s ago — worked bot#12, made progress$/m);
    assert.match(renderStatusText(snapshot({ cron, cronAlive: false })), /\[cron process not running\]/);
    const retry = { ...cron, outcome: { kind: 'ran', repo: 'bot', issue: 12, result: 'merge_retry', note: 'merge hit a network error' } };
    assert.match(renderStatusText(snapshot({ cron: retry, cronAlive: true })), /— worked bot#12, merge retried next tick \(merge hit a network error\)$/m);
    const starting = { ...cron, lastTickStartedAt: null, lastTickEndedAt: null, outcome: null };
    assert.match(renderStatusText(snapshot({ cron: starting, cronAlive: true })), /^Cron: starting/m);
    const paused = { ...cron, outcome: { kind: 'paused' } };
    assert.match(renderStatusText(snapshot({ cron: paused, cronAlive: true })), /^Cron: last tick 5m00s ago — skipped, agent-runner was paused$/m);
  });

  it("totals today's spend and lists the last 3 runs, compactly", () => {
    const history = [1, 2, 3, 4].map((i) => row({ runId: `r${i}`, label: `job ${i}`, endedAt: ago(i * MIN) }));
    history.push(row({ runId: 'old', endedAt: ago(24 * 60 * MIN) }));
    const text = renderStatusText(snapshot({ history }));
    assert.match(text, /^Today: 4 runs · \$1\.68 · 12k tok$/m);
    assert.match(text, /job 1/);
    assert.match(text, /job 3/);
    assert.doesNotMatch(text, /job 4/);
    assert.ok(text.split('\n').length <= 12, text);
    assert.doesNotMatch(text, /\.log/, 'no log paths or excerpts on WhatsApp');
  });
});

describe('renderHistoryText (WhatsApp)', () => {
  it('lists runs one per line with outcome, duration, cost and tokens', () => {
    const text = renderHistoryText([row(), row({ runId: 'r2', label: undefined, kind: 'joplin', outcome: 'failed', costUsd: null, endedAt: ago(125 * MIN) })], NOW);
    const [header, first, second] = text.split('\n');
    assert.equal(header, 'Last 2 runs:');
    assert.equal(first, '10m00s ago · list the repos — success, 5m00s, $0.42, 3.0k tok');
    assert.equal(second, '2h05m ago · joplin — failed, 5m00s, -, 3.0k tok');
  });

  it('shows a scheduled job without cost or tokens', () => {
    const text = renderHistoryText([row({ kind: 'job', label: 'scheduled job cleanup_agent', trigger: 'schedule', outcome: 'failed', costUsd: undefined, tokens: undefined, model: undefined, turns: undefined })], NOW);
    assert.equal(text.split('\n')[1], '10m00s ago · scheduled job cleanup_agent — failed, 5m00s');
  });

  it('computes the duration when the entry has none', () => {
    const text = renderHistoryText([row({ durationMs: undefined })], NOW);
    assert.match(text, /success, 5m00s/);
    assert.match(text, /^Last run:/);
  });

  it('says when nothing has run yet', () => {
    assert.equal(renderHistoryText([], NOW), 'No finished runs recorded yet.');
  });
});

describe('terminal rendering', () => {
  it('renders every section of the status dashboard', () => {
    const text = renderStatus(
      snapshot({
        active: [
          { runId: 'r9', kind: 'freeform', label: 'fix', startedAt: ago(MIN), turns: 2, ownerPid: 1, agentPid: 2, health: 'running', lastActivity: 'Read: x' },
          { runId: 'r8', kind: 'freeform', label: 'old', startedAt: ago(MIN), ownerPid: 3, agentPid: 4, health: 'orphaned' },
        ],
        paused: { reason: 'safe-restart', pausedAt: ago(MIN), token: 't' },
        history: [row()],
      })
    );
    for (const heading of ['CRON', 'AGENTS', 'PAUSED', 'SPEND', 'RECENT']) assert.match(text, new RegExp(`^${heading}`, 'm'));
    assert.match(text, /2 running.*1 need attention/);
    assert.match(text, /r8: runner died but agent pid 4 is still running/);
    assert.match(text, /safe-restart/);
    assert.match(text, /list the repos/);
  });

  it('renders history as a table with a row per run', () => {
    const lines = renderHistoryLines([row(), row({ runId: 'r2' })], NOW);
    assert.match(lines[1], /ended.*outcome.*cost.*run/);
    assert.equal(lines.filter((l) => /\$0\.42/.test(l)).length, 2);
  });
});
