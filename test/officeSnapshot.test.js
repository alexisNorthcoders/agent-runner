import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOfficeSnapshot, collectOfficeSnapshot } from '../src/officeSnapshot.js';
import { spend } from '../src/statusFormat.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');

/** @returns {import('../src/statusCollect.js').StatusSnapshot} */
function status(overrides = {}) {
  return {
    now: NOW,
    active: [
      {
        runId: 'r1',
        kind: 'issue',
        label: 'issue bot#7 "Fix it"',
        replyTo: '123@s.whatsapp.net',
        workspaceRoot: '/home/u/Projects/bot',
        logPath: '/runner/logs/r1.log',
        workspaceAlias: 'bot',
        issueNumber: 7,
        trigger: 'cron',
        startedAt: '2026-09-24T11:50:00Z',
        ownerPid: 1,
        agentPid: 2,
        model: 'claude-sonnet-5',
        turns: 4,
        outputTokens: 900,
        contextTokens: 20_000,
        lastActivity: 'Read src/a.js',
        health: 'running',
      },
    ],
    paused: null,
    cron: { pid: 1, intervalMs: 600_000, lastTickStartedAt: '2026-09-24T11:55:00Z', lastTickEndedAt: '2026-09-24T11:55:02Z', outcome: { kind: 'no_eligible' } },
    cronAlive: true,
    history: [
      {
        runId: 'h1',
        kind: 'freeform',
        label: 'say hi',
        replyTo: 'jid',
        workspaceRoot: '/home/u/Projects',
        logPath: '/runner/logs/h1.log',
        startedAt: '2026-09-24T10:00:00Z',
        endedAt: '2026-09-24T10:01:00Z',
        durationMs: 60_000,
        outcome: 'success',
        model: 'claude-sonnet-5',
        turns: 2,
        costUsd: 0.5,
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
      },
      { runId: 'h0', endedAt: '2026-09-20T10:00:00Z', outcome: 'failed', costUsd: 1, kind: 'issue', trigger: 'cron', workspaceAlias: 'bot', issueNumber: 3, result: 'failed' },
    ],
    queue: [{ id: 'q1', cmd: { kind: 'freeform', prompt: 'secret-ish prompt' }, replyTo: 'jid', label: 'next job', queuedAt: '2026-09-24T11:59:00Z' }],
    manualPauses: [
      { scope: 'all', reason: 'lunch', pausedAt: '2026-09-24T11:00:00Z', until: '2026-09-24T13:00:00Z' },
      { scope: 'chess', reason: '', pausedAt: '2026-09-24T11:30:00Z', until: '2026-09-24T12:30:00Z' },
    ],
    lock: { runId: 'r1', kind: 'issue', label: 'issue bot#7 "Fix it"', replyTo: 'jid', startedAt: '2026-09-24T11:50:00Z', logPath: '/x', workspaceRoot: '/y', ownerPid: 1, agentPid: 2, workspaceAlias: 'bot', issueNumber: 7, trigger: 'cron' },
    ...overrides,
  };
}

describe('buildOfficeSnapshot', () => {
  it('describes the active run with its live phase and progress, and how long it has run', () => {
    const s = buildOfficeSnapshot({
      status: status(),
      live: { runId: 'r1', phase: 'post-run', turns: 6, lastActivity: 'Edit src/a.js' },
      workspaces: ['bot', 'chess'],
    });
    assert.equal(s.version, 1);
    assert.equal(s.at, '2026-09-24T12:00:00.000Z');
    assert.deepEqual(s.activeRun, {
      runId: 'r1',
      kind: 'issue',
      trigger: 'cron',
      label: 'issue bot#7 "Fix it"',
      workspaceAlias: 'bot',
      issueNumber: 7,
      room: null,
      health: 'running',
      phase: 'post-run',
      model: 'claude-sonnet-5',
      turns: 6,
      outputTokens: 900,
      contextTokens: 20_000,
      lastActivity: 'Edit src/a.js',
      startedAt: '2026-09-24T11:50:00Z',
      elapsedMs: 600_000,
      agentPid: 2,
    });
    assert.deepEqual(s.active, [s.activeRun]);
    assert.deepEqual(s.workspaces, ['bot', 'chess']);
  });

  it('leaves out paths and reply addresses', () => {
    const json = JSON.stringify(buildOfficeSnapshot({ status: status(), live: null, workspaces: [] }));
    for (const secret of ['/home/u', '/runner/logs', 'whatsapp.net', 'jid', 'secret-ish prompt']) assert.ok(!json.includes(secret), secret);
  });

  it('has no phase for a run this process is not executing, and no active run when idle', () => {
    const orphan = status();
    orphan.active[0].health = 'orphaned';
    const s = buildOfficeSnapshot({ status: orphan, live: null, workspaces: [] });
    assert.equal(s.activeRun, null);
    assert.equal(s.active[0].phase, null);
    assert.equal(s.active[0].health, 'orphaned');

    const idle = buildOfficeSnapshot({ status: status({ active: [], lock: null }), live: null, workspaces: [] });
    assert.equal(idle.activeRun, null);
    assert.deepEqual(idle.active, []);
    assert.equal(idle.lock, null);
  });

  it('lists the queue, the lock holder and every pause', () => {
    const s = buildOfficeSnapshot({ status: status({ paused: { token: 't', reason: 'safe-restart', pausedAt: '2026-09-24T11:59:30Z' } }), live: null, workspaces: [] });
    assert.deepEqual(s.queue, [{ id: 'q1', kind: 'freeform', label: 'next job', queuedAt: '2026-09-24T11:59:00Z' }]);
    assert.deepEqual(s.lock, { runId: 'r1', kind: 'issue', trigger: 'cron', label: 'issue bot#7 "Fix it"', workspaceAlias: 'bot', issueNumber: 7, room: null, startedAt: '2026-09-24T11:50:00Z' });
    assert.deepEqual(s.pauses, {
      restart: { reason: 'safe-restart', pausedAt: '2026-09-24T11:59:30Z' },
      general: { reason: 'lunch', pausedAt: '2026-09-24T11:00:00Z', until: '2026-09-24T13:00:00Z' },
      workspaces: [{ alias: 'chess', reason: '', pausedAt: '2026-09-24T11:30:00Z', until: '2026-09-24T12:30:00Z' }],
    });
    const unknown = buildOfficeSnapshot({ status: status({ paused: 'unknown', manualPauses: [] }), live: null, workspaces: [] });
    assert.deepEqual(unknown.pauses, { restart: 'unknown', general: null, workspaces: [] });
  });

  it('gives the cron state with its next tick, only while the cron is alive', () => {
    const s = buildOfficeSnapshot({ status: status(), live: null, workspaces: [] });
    assert.deepEqual(s.cron, {
      alive: true,
      pid: 1,
      intervalMs: 600_000,
      lastTickStartedAt: '2026-09-24T11:55:00Z',
      lastTickEndedAt: '2026-09-24T11:55:02Z',
      outcome: { kind: 'no_eligible' },
      nextTickAt: '2026-09-24T12:05:00.000Z',
    });
    const dead = buildOfficeSnapshot({ status: status({ cronAlive: false }), live: null, workspaces: [] });
    assert.equal(dead.cron?.alive, false);
    assert.equal(dead.cron?.nextTickAt, null);
    assert.equal(buildOfficeSnapshot({ status: status({ cron: null }), live: null, workspaces: [] }).cron, null);
  });

  it('marks a scheduled job with trigger schedule and its room', () => {
    const job = { runId: 'j1', kind: 'job', trigger: /** @type {const} */ ('schedule'), jobName: 'cleanup_agent', room: 'reddit-bot', label: 'scheduled job cleanup_agent' };
    const st = status();
    const s = buildOfficeSnapshot({
      status: { ...st, lock: { ...job, startedAt: '2026-09-24T11:50:00Z' }, history: [{ ...job, endedAt: '2026-09-24T10:01:00Z', outcome: 'success' }] },
      live: null,
      workspaces: [],
    });
    assert.equal(s.lock?.trigger, 'schedule');
    assert.equal(s.lock?.room, 'reddit-bot');
    assert.equal(s.history[0].trigger, 'schedule');
    assert.equal(s.history[0].room, 'reddit-bot');
  });

  it('carries 7 days of history and the same spend totals as agent:status', () => {
    const st = status();
    const s = buildOfficeSnapshot({ status: st, live: null, workspaces: [] });
    assert.deepEqual(s.history.map((h) => h.runId), ['h1', 'h0']);
    assert.deepEqual(s.history[0], {
      runId: 'h1',
      kind: 'freeform',
      trigger: 'manual',
      label: 'say hi',
      workspaceAlias: null,
      issueNumber: null,
      room: null,
      startedAt: '2026-09-24T10:00:00Z',
      endedAt: '2026-09-24T10:01:00Z',
      durationMs: 60_000,
      outcome: 'success',
      result: null,
      model: 'claude-sonnet-5',
      turns: 2,
      costUsd: 0.5,
      tokens: 10,
    });
    assert.equal(s.history[1].result, 'failed');
    const { today, week } = spend(st);
    assert.deepEqual(s.spend, {
      today: { runs: today.n, costUsd: today.cost, tokens: today.tokens },
      week: { runs: week.n, costUsd: week.cost, tokens: week.tokens },
    });
  });
});

describe('collectOfficeSnapshot', () => {
  it('reads the status, the live run and the allowlist, and still builds when the allowlist fails', async () => {
    const st = status();
    const s = await collectOfficeSnapshot({
      statusSnapshot: async () => st,
      liveRun: async () => ({ busy: true, activeRun: { runId: 'r1', phase: 'agent', turns: 9 } }),
      workspaceAliases: async () => {
        throw new Error('bad map file');
      },
    });
    assert.equal(s.activeRun?.phase, 'agent');
    assert.equal(s.activeRun?.turns, 9);
    assert.deepEqual(s.workspaces, []);
  });
});
