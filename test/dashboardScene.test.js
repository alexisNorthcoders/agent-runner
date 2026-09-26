import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reduceScene } from '../dashboard/scene.js';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();

/** A minimal OfficeSnapshot, with `over` on top. @returns {any} */
function snap(over = {}) {
  return {
    version: 1,
    at: iso(0),
    activeRun: null,
    active: [],
    queue: [],
    pauses: { restart: null, general: null, workspaces: [] },
    cron: null,
    lock: null,
    history: [],
    spend: { today: { runs: 0, costUsd: 0, tokens: 0 }, week: { runs: 0, costUsd: 0, tokens: 0 } },
    workspaces: ['bot', 'chess-trainer', 'dots'],
    ...over,
  };
}

const up = { up: true, now: NOW, config: {} };
const pause = (ms, reason = 'r') => ({ reason, pausedAt: iso(-60_000), until: iso(ms) });

describe('office scene: cubicles', () => {
  it('gives every allowlisted workspace a cubicle named by its alias', () => {
    const scene = reduceScene(snap(), null, up);
    assert.deepEqual(
      scene.cubicles.map((c) => [c.alias, c.name]),
      [
        ['bot', 'bot'],
        ['chess-trainer', 'chess-trainer'],
        ['dots', 'dots'],
      ]
    );
  });

  it('renames and reorders cubicles from the config, and keeps the rest after them', () => {
    const config = { cubicles: [{ alias: 'dots', name: 'Accounting' }, { alias: 'gone', name: 'Old' }, { alias: 'bot' }] };
    const scene = reduceScene(snap(), null, { ...up, config });
    assert.deepEqual(
      scene.cubicles.map((c) => [c.alias, c.name]),
      [
        ['dots', 'Accounting'],
        ['bot', 'bot'],
        ['chess-trainer', 'chess-trainer'],
      ]
    );
  });

  it('shrugs off a broken config', () => {
    for (const config of [null, undefined, 'x', { cubicles: 'x' }, { cubicles: [null, 3, { name: 'no alias' }] }]) {
      assert.equal(reduceScene(snap(), null, { ...up, config }).cubicles.length, 3, JSON.stringify(config));
    }
  });
});

describe('office scene: office states', () => {
  it('is lit while the runner is up', () => {
    const scene = reduceScene(snap(), null, up);
    assert.equal(scene.dark, false);
    assert.equal(scene.backInFive, false);
    assert.ok(scene.cubicles.every((c) => !c.doNotDisturb));
  });

  it('goes dark when the runner is down, keeping the floor it last saw', () => {
    const lit = reduceScene(snap(), null, up);
    const dark = reduceScene(snap(), lit, { ...up, up: false });
    assert.equal(dark.dark, true);
    assert.deepEqual(
      dark.cubicles.map((c) => c.alias),
      lit.cubicles.map((c) => c.alias)
    );
    assert.equal(reduceScene(snap(), dark, up).dark, false);
  });

  it('is dark with an empty floor when the runner was never seen', () => {
    const scene = reduceScene(null, null, { ...up, up: false });
    assert.equal(scene.dark, true);
    assert.deepEqual(scene.cubicles, []);
  });

  it('hangs BACK IN 5 on the door during a general pause, until it ends', () => {
    const paused = snap({ pauses: { restart: null, general: pause(60_000), workspaces: [] } });
    assert.equal(reduceScene(paused, null, up).backInFive, true);
    // expired, though the next snapshot hasn't said so yet
    assert.equal(reduceScene(paused, null, { ...up, now: NOW + 61_000 }).backInFive, false);
    assert.equal(reduceScene(snap(), reduceScene(paused, null, up), up).backInFive, false);
  });

  it('hangs Do not disturb on a paused workspace, until it ends', () => {
    const paused = snap({ pauses: { restart: null, general: null, workspaces: [{ alias: 'chess-trainer', ...pause(60_000) }] } });
    const dnd = (scene) => scene.cubicles.filter((c) => c.doNotDisturb).map((c) => c.alias);
    assert.deepEqual(dnd(reduceScene(paused, null, up)), ['chess-trainer']);
    assert.deepEqual(dnd(reduceScene(paused, null, { ...up, now: NOW + 61_000 })), []);
    assert.deepEqual(dnd(reduceScene(snap(), reduceScene(paused, null, up), up)), []);
  });
});

describe('office scene: reception', () => {
  const cron = (over = {}) => ({ alive: true, pid: 1, intervalMs: 600_000, lastTickStartedAt: iso(-60_000), lastTickEndedAt: iso(-50_000), outcome: null, nextTickAt: iso(540_000), ...over });

  it("counts down to the feed's next cron tick", () => {
    assert.equal(reduceScene(snap({ cron: cron() }), null, up).reception.countdownMs, 540_000);
    assert.equal(reduceScene(snap({ cron: cron() }), null, { ...up, now: NOW + 40_000 }).reception.countdownMs, 500_000);
  });

  it('holds at zero once the tick is due', () => {
    assert.equal(reduceScene(snap({ cron: cron({ nextTickAt: iso(-5_000) }) }), null, up).reception.countdownMs, 0);
  });

  it('hides the countdown when the cron is off, dead or has no next tick', () => {
    for (const c of [null, cron({ alive: false, nextTickAt: null }), cron({ nextTickAt: null })]) {
      assert.equal(reduceScene(snap({ cron: c }), null, up).reception.countdownMs, null, JSON.stringify(c));
    }
  });

  it('puts one letter on the mail cart per queued request, oldest first', () => {
    const queue = [
      { id: 'q1', kind: 'freeform', label: 'say hi', queuedAt: iso(-2000) },
      { id: 'q2', kind: 'issue', label: 'issue bot#7', queuedAt: iso(-1000) },
    ];
    assert.deepEqual(reduceScene(snap({ queue }), null, up).reception.letters, [
      { id: 'q1', label: 'say hi' },
      { id: 'q2', label: 'issue bot#7' },
    ]);
    assert.deepEqual(reduceScene(snap(), null, up).reception.letters, []);
  });
});
