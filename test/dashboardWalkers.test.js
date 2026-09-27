import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deskAt, layoutOffice, workerRect } from '../dashboard/layout.js';
import { HAND_MS, RING_MS, WALK_MS, walkers } from '../dashboard/walkers.js';

/** @typedef {import('../dashboard/scene.js').Scene} Scene */
/** @typedef {import('../dashboard/scene.js').SceneRun} SceneRun */

const cubicles = ['bot', 'dots'].map((alias) => ({ alias, name: alias, workspace: true, doNotDisturb: false, inTray: [], sticky: [], jobs: [] }));
const layout = layoutOffice(cubicles.length, 'wide', 640);
/** @type {import('../dashboard/scene.js').Place} */
const BOT = { room: 'cubicle', alias: 'bot' };
const desk = deskAt(layout, cubicles, BOT);

/** An active run in the bot cubicle, delivered at 0, with `over` on top. @param {Partial<SceneRun>} over @returns {SceneRun} */
const run = (over = {}) => ({
  runId: 'r1',
  label: null,
  activity: null,
  place: BOT,
  worker: null,
  delivery: { by: 'phone', at: 0 },
  work: 'typing',
  pile: 3,
  bubble: null,
  postRun: false,
  moved: null,
  ...over,
});

/** A lit scene with no walks, and `over` on top. @param {Partial<Scene>} over @returns {Scene} */
const scene = (over = {}) => ({
  dark: false,
  backInFive: false,
  cubicles,
  queueRoom: { countdownMs: null, letters: [] },
  run: null,
  boss: { at: null, from: null, since: 0 },
  outcomes: [],
  parked: [],
  ...over,
});

/** @param {Scene} sc @param {number} t */
const at = (sc, t) => walkers(layout, sc.cubicles, sc, t);

describe('office walkers: the delivery', () => {
  const phoned = scene({ run: run() });
  const leave = RING_MS;
  const arrive = leave + WALK_MS;
  const back = arrive + HAND_MS + WALK_MS;

  it('rings the phone at the front desk before the carrier leaves', () => {
    const c = at(phoned, leave - 1).carrier;
    assert.equal(c.pose, 'standing');
    assert.equal(c.carrying, 'phone');
    const home = { x: c.x, y: c.y };
    const out = at(phoned, leave + 1).carrier;
    assert.equal(out.pose, 'walking');
    assert.equal(out.carrying, 'phone');
    assert.notDeepEqual({ x: out.x, y: out.y }, home);
  });

  it('sets off at once with an envelope', () => {
    const c = at(scene({ run: run({ delivery: { by: 'envelope', at: 0 } }) }), 1).carrier;
    assert.equal(c.pose, 'walking');
    assert.equal(c.carrying, 'envelope');
  });

  it('puts the worker at the desk only once the carrier arrives', () => {
    assert.equal(at(phoned, arrive - 1).worker, null);
    const w = at(phoned, arrive).worker;
    assert.equal(w.pose, 'seated');
    const r = workerRect(desk);
    assert.deepEqual([w.x, w.y, w.pile], [r.x, r.y, 3]);
  });

  it('hands the run over, walks back empty-handed and stands at the front desk again', () => {
    assert.equal(at(phoned, arrive + HAND_MS - 1).carrier.carrying, 'phone');
    const returning = at(phoned, arrive + HAND_MS + 1).carrier;
    assert.deepEqual([returning.pose, returning.carrying], ['walking', null]);
    const home = at(phoned, 0).carrier;
    const c = at(phoned, back).carrier;
    assert.deepEqual(c, { ...home, carrying: null });
    assert.equal(c.pose, 'standing');
    assert.deepEqual(at(scene(), back).carrier, c);
  });

  it('has the worker at the desk all along in post-run, with no delivery', () => {
    const post = scene({ run: run({ postRun: true, work: 'reviewed' }) });
    assert.equal(at(post, 1).worker.pose, 'seated');
    const c = at(post, 1).carrier;
    assert.deepEqual([c.pose, c.carrying], ['standing', null]);
  });
});

describe('office walkers: the boss', () => {
  it('sits at home when there is no run', () => {
    const b = at(scene(), 10_000).boss;
    assert.equal(b.pose, 'seated');
  });

  it('walks to the worker\'s shoulder after boss.since, then stands there', () => {
    const since = 5000;
    const sc = scene({ run: run({ postRun: true, work: 'reviewed' }), boss: { at: BOT, from: null, since } });
    const home = at(scene(), 1e9).boss;
    const start = at(sc, since).boss;
    assert.equal(start.pose, 'walking');
    const mid = at(sc, since + WALK_MS / 2).boss;
    assert.equal(mid.pose, 'walking');
    assert.notDeepEqual([mid.x, mid.y], [start.x, start.y]);
    const there = at(sc, since + WALK_MS).boss;
    assert.equal(there.pose, 'standing');
    const w = workerRect(desk);
    assert.ok(Math.abs(there.x - w.x) < 20 && Math.abs(there.y - w.y) < 10, 'by the worker');
    assert.notDeepEqual([there.x, there.y], [home.x, home.y]);
  });

  it('walks back home and sits down once the run is over', () => {
    const since = 5000;
    const sc = scene({ boss: { at: null, from: BOT, since } });
    assert.equal(at(sc, since + 1).boss.pose, 'walking');
    assert.deepEqual(at(sc, since + WALK_MS).boss, at(scene(), 1e9).boss);
  });
});

describe('office walkers: a freeform worker moving desks', () => {
  const since = 20_000;
  const moving = scene({ run: run({ moved: { from: { room: 'freeform' }, since } }) });

  it('starts the move after the hand-over and ends at the new desk', () => {
    const from = workerRect(layout.desks.freeform);
    const to = workerRect(desk);
    const before = at(moving, since - 1).worker;
    assert.equal(before.pose, 'seated');
    const start = at(moving, since).worker;
    assert.deepEqual([start.pose, start.x, start.y, start.pile], ['walking', from.x, from.y, 3]);
    assert.equal(at(moving, since + WALK_MS - 1).worker.pose, 'walking');
    const end = at(moving, since + WALK_MS).worker;
    assert.deepEqual([end.pose, end.x, end.y], ['seated', to.x, to.y]);
  });

  it('waits for the carrier to arrive before moving', () => {
    const early = scene({ run: run({ moved: { from: { room: 'freeform' }, since: 0 } }) });
    const arrive = RING_MS + WALK_MS;
    assert.equal(at(early, arrive - 1).worker, null);
    assert.equal(at(early, arrive).worker.pose, 'walking');
    assert.equal(at(early, arrive + WALK_MS).worker.pose, 'seated');
  });
});

describe('office walkers: animating', () => {
  it('is still once every walk is over and nothing on the floor moves', () => {
    const since = 5000;
    const sc = scene({ boss: { at: null, from: BOT, since } });
    assert.equal(at(sc, since + WALK_MS - 1).animating, true);
    assert.equal(at(sc, since + WALK_MS).animating, false);
  });

  it('keeps going while a run is on the floor or a resting state moves, but not in the dark', () => {
    assert.equal(at(scene({ run: run() }), 1e9).animating, true);
    /** @type {import('../dashboard/scene.js').SceneOutcome} */
    const asleep = { place: BOT, state: 'asleep', quick: false, runId: 'r0', label: null, outcome: '', recorded: '', endedAt: 0, prUrl: null };
    assert.equal(at(scene({ outcomes: [asleep] }), 1e9).animating, true);
    assert.equal(at(scene({ outcomes: [{ ...asleep, state: 'injured' }] }), 1e9).animating, false);
    assert.equal(at(scene({ run: run(), dark: true }), 1).animating, false);
  });
});
