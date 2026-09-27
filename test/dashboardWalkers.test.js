import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WALL, deskAt, inside, layoutOffice, workerRect } from '../dashboard/layout.js';
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

/**
 * When the carrier arrives with the run: the first moment its worker is at the desk.
 * @param {Scene} sc @param {(sc: Scene, t: number) => ReturnType<typeof walkers>} [look]
 */
function arrival(sc, look = at) {
  let [lo, hi] = [0, 120_000];
  assert.ok(look(sc, hi).worker, 'the carrier arrives');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (look(sc, mid).worker) hi = mid;
    else lo = mid;
  }
  return hi;
}

describe('office walkers: the delivery', () => {
  const phoned = scene({ run: run() });
  const leave = RING_MS;
  const arrive = arrival(phoned);
  const back = arrive + HAND_MS + (arrive - leave);

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
    const there = at(phoned, arrive).carrier;
    assert.notDeepEqual(at(phoned, arrive - 20).carrier, there, 'still walking just before');
    assert.deepEqual(at(phoned, arrive + HAND_MS - 1).carrier, there, 'standing still for the hand-over');
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

describe('office walkers: the carrier walks the corridors and aisles', () => {
  /** @type {import('../dashboard/scene.js').SceneJobDesk} */
  const backup = { name: 'backup', worker: 'clerk', at: '03:00', nextDueAt: null };
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => ({ ...cubicles[0], alias, name: alias, jobs: alias === 'f' ? [backup] : [] }));
  /** @param {number} n @param {number} [width] */
  const wide = (n, width = 640) => layoutOffice(n, 'wide', width);
  /** @param {import('../dashboard/scene.js').Place} place @param {typeof many} cs */
  const delivering = (place, cs = many) => scene({ cubicles: cs, run: run({ place, delivery: { by: 'envelope', at: 0 } }) });
  /** @param {import('../dashboard/layout.js').Layout} l */
  const look = (l) => (/** @type {Scene} */ sc, /** @type {number} */ t) => walkers(l, sc.cubicles, sc, t);

  /** Where the carrier can't be: a room's walls (but its doorway), the back wall, a cubicle's partitions. @param {import('../dashboard/layout.js').Layout} l */
  function solid(l) {
    const walls = [{ x: 0, y: 0, w: l.width, h: WALL }];
    for (const id of /** @type {const} */ (['review', 'joplin', 'queueRoom', 'freeform'])) {
      const r = l.rooms[id].rect;
      walls.push({ x: r.x, y: r.y, w: r.w, h: 1 }, { x: r.x, y: r.y + r.h - 1, w: r.w, h: 1 }, { x: r.x, y: r.y, w: 1, h: r.h }, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h });
    }
    for (const r of l.cubicles) walls.push({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: 12 }, { x: r.x + 2, y: r.y + 2, w: 3, h: r.h - 4 }, { x: r.x + r.w - 5, y: r.y + 2, w: 3, h: r.h - 4 });
    const doorways = Object.values(l.doorways);
    /** the carrier's feet, at the bottom of their sprite @param {{ x: number, y: number }} c */
    return (c) =>
      [[c.x + 2, c.y - 1], [c.x + 7, c.y - 1]].some(([x, y]) => walls.some((w) => inside(w, x, y)) && !doorways.some((d) => inside(d, x, y)));
  }

  it('is never inside a wall or a cubicle partition, there and back', () => {
    /** @type {import('../dashboard/scene.js').Place[]} */
    const places = [
      ...many.map((c) => ({ room: /** @type {const} */ ('cubicle'), alias: c.alias })),
      { room: 'cubicle', alias: 'f', job: 'backup' },
      { room: 'freeform' },
      { room: 'joplin' },
    ];
    for (const width of [560, 720]) {
      const l = wide(many.length, width);
      const blocked = solid(l);
      for (const place of places) {
        const sc = delivering(place);
        const arrive = arrival(sc, look(l));
        const back = 2 * arrive + HAND_MS;
        let passed = 0;
        for (let t = 0; t <= back; t += 8) {
          const c = look(l)(sc, t).carrier;
          assert.ok(!blocked(c), `${width} ${JSON.stringify(place)} at ${t}: ${JSON.stringify(c)}`);
          if (Object.values(l.doorways).some((d) => inside(d, c.x + 4, c.y - 1))) passed++;
        }
        assert.ok(passed > 0, `${JSON.stringify(place)}: out through a doorway`);
      }
    }
  });

  it('arrives sooner at a nearer cubicle', () => {
    const l = wide(many.length);
    // the Queue room is on the right: d is the front row's rightmost cubicle, a its leftmost, e behind them
    const [a, d, e] = ['a', 'd', 'e'].map((alias) => arrival(delivering({ room: 'cubicle', alias }), look(l)));
    assert.ok(d < a, `d ${d} before a ${a}`);
    assert.ok(a < e, `a ${a} before e ${e}`);
    const joplin = arrival(delivering({ room: 'joplin' }), look(l));
    assert.ok(joplin > a, 'the Joplin room is across the office');
  });

  it('faces the way they walk', () => {
    const l = look(wide(many.length));
    const sc = delivering({ room: 'cubicle', alias: 'a' });
    const arrive = arrival(sc, l);
    let [left, right] = [0, 0];
    for (let t = 0; t < 2 * arrive; t += 50) {
      const [c, next] = [l(sc, t).carrier, l(sc, t + 50).carrier];
      if (c.pose !== 'walking' || next.pose !== 'walking' || next.y !== c.y) continue;
      if (next.x < c.x) {
        left++;
        assert.equal(next.facing, 'left', `heading left at ${t}`);
      } else if (next.x > c.x) {
        right++;
        assert.equal(next.facing, 'right', `heading right at ${t}`);
      }
    }
    assert.ok(left > 0 && right > 0, 'walks both ways');
  });

  it('carries on along the new route when a cubicle is added mid-walk', () => {
    const before = many.slice(0, 5);
    const sc = delivering({ room: 'cubicle', alias: 'a' }, before);
    const mid = Math.floor(arrival(sc, look(wide(5))) / 2);
    const grown = { ...sc, cubicles: many };
    const l = wide(many.length);
    const c = look(l)(grown, mid).carrier;
    assert.equal(c.pose, 'walking');
    const route = [];
    for (let t = 0; t <= arrival(grown, look(l)); t += 4) route.push(look(l)(grown, t).carrier);
    assert.ok(route.some((p) => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) <= 1), `${JSON.stringify(c)} on the new route`);
    assert.ok(!solid(l)(c));
  });

  it('seats the worker exactly when the carrier arrives, on the route of the layout at t', () => {
    // the office is resized mid-walk: arrival is the new route's, for the carrier and the worker alike
    const sc = delivering({ room: 'cubicle', alias: 'a' });
    const l = wide(many.length, 720);
    const arrive = arrival(sc, look(l));
    assert.ok(arrive > arrival(sc, look(wide(many.length, 560))), 'the new route is longer');
    const [before, now, handing] = [arrive - 1, arrive, arrive + HAND_MS / 2].map((t) => look(l)(sc, t));
    assert.equal(before.worker, null);
    assert.equal(before.carrier.carrying, 'envelope');
    assert.ok(now.worker);
    assert.deepEqual([now.carrier.x, now.carrier.y], [handing.carrier.x, handing.carrier.y], 'at the hand-over point');
    assert.ok(Math.abs(before.carrier.x - now.carrier.x) + Math.abs(before.carrier.y - now.carrier.y) <= 1, 'arriving, not jumping');
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
    const arrive = arrival(early);
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
