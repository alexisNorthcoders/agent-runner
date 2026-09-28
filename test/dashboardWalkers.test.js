import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WALL, cubicleDesks, deskAt, deskOwners, inside, layoutOffice, workerRect } from '../dashboard/layout.js';
import { BOSS_FEET, HAND_MS, RING_MS, WORKER_FEET, walkers } from '../dashboard/walkers.js';

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

/** Every room's and corridor's back wall. @param {import('../dashboard/layout.js').Layout} l */
const backWalls = (l) => [...Object.values(l.rooms).map((r) => r.rect), ...l.corridors].map((r) => ({ x: r.x, y: r.y, w: r.w, h: WALL }));

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

  /** Where the carrier can't be: a room's walls (but its doorway), the back walls, a cubicle's partitions. @param {import('../dashboard/layout.js').Layout} l */
  function solid(l) {
    const walls = backWalls(l);
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
    // the office is resized mid-walk onto a longer route: the carrier arrives when they would have
    // on the old one, and the worker with them
    const sc = delivering({ room: 'cubicle', alias: 'a' });
    const l = wide(many.length, 720);
    const arrive = arrival(sc, look(l));
    assert.equal(arrive, arrival(sc, look(wide(many.length, 560))));
    const [before, now, handing] = [arrive - 1, arrive, arrive + HAND_MS / 2].map((t) => look(l)(sc, t));
    assert.equal(before.worker, null);
    assert.equal(before.carrier.carrying, 'envelope');
    assert.ok(now.worker);
    assert.deepEqual([now.carrier.x, now.carrier.y], [handing.carrier.x, handing.carrier.y], 'at the hand-over point');
    assert.ok(Math.abs(before.carrier.x - now.carrier.x) + Math.abs(before.carrier.y - now.carrier.y) <= 1, 'arriving, not jumping');
  });
});

/**
 * Where nobody's feet can be: a room's walls (but its doorway), the back wall, a cubicle's
 * partitions, and every desk (the front desk, the rooms' desks and each cubicle's).
 * @param {import('../dashboard/layout.js').Layout} l @param {typeof cubicles} cs
 */
function solidWithDesks(l, cs) {
  const walls = [...backWalls(l), l.desk, ...Object.values(l.desks)];
  for (const id of /** @type {const} */ (['review', 'joplin', 'queueRoom', 'freeform'])) {
    const r = l.rooms[id].rect;
    walls.push({ x: r.x, y: r.y, w: r.w, h: 1 }, { x: r.x, y: r.y + r.h - 1, w: r.w, h: 1 }, { x: r.x, y: r.y, w: 1, h: r.h }, { x: r.x + r.w - 1, y: r.y, w: 1, h: r.h });
  }
  cs.forEach((c, i) => {
    const r = l.cubicles[i];
    walls.push({ x: r.x + 2, y: r.y + 2, w: r.w - 4, h: 12 }, { x: r.x + 2, y: r.y + 2, w: 3, h: r.h - 4 }, { x: r.x + r.w - 5, y: r.y + 2, w: 3, h: r.h - 4 });
    walls.push(...cubicleDesks(r, deskOwners(c).length));
  });
  const doorways = Object.values(l.doorways);
  /** a figure's feet, `feet` below the top of their head @param {{ x: number, y: number }} p @param {number} feet */
  return (p, feet) =>
    [[p.x + 2, p.y + feet - 1], [p.x + 7, p.y + feet - 1]].some(([x, y]) => walls.some((w) => inside(w, x, y)) && !doorways.some((d) => inside(d, x, y)));
}


/**
 * The first t from `from` at which `done` holds, by bisection (it holds from then on).
 * @param {(t: number) => boolean} done @param {number} from
 */
function firstWhen(done, from) {
  let [lo, hi] = [from, from + 120_000];
  assert.ok(done(hi), 'it happens');
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (done(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

describe('office walkers: the boss walks the corridors', () => {
  const since = 5000;
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => ({ ...cubicles[0], alias, name: alias }));
  const l = layoutOffice(many.length, 'wide', 640);
  /** @param {Scene} sc @param {number} t */
  const look = (sc, t) => walkers(l, sc.cubicles, sc, t);
  /** @param {string} alias @returns {import('../dashboard/scene.js').Place} */
  const cube = (alias) => ({ room: 'cubicle', alias });
  /** Post-run in `alias`'s cubicle, the boss setting off at `since`. @param {string} alias */
  const going = (alias) => scene({ cubicles: many, run: run({ place: cube(alias), postRun: true, work: 'reviewed' }), boss: { at: cube(alias), from: null, since } });
  /** The run over, the boss setting off back from `alias`'s cubicle at `since`. @param {string} alias */
  const returning = (alias) => scene({ cubicles: many, boss: { at: null, from: cube(alias), since } });
  /** When the boss stops walking. @param {Scene} sc */
  const arrival = (sc) => firstWhen((t) => look(sc, t).boss.pose !== 'walking', since);
  const home = look(scene({ cubicles: many }), 1e9).boss;

  it('is never inside a wall, partition or desk, there and back', () => {
    for (const width of [560, 720]) {
      const lw = layoutOffice(many.length, 'wide', width);
      const blocked = solidWithDesks(lw, many);
      for (const alias of ['a', 'd', 'f']) {
        for (const sc of [going(alias), returning(alias)]) {
          let through = 0;
          for (let t = since; t <= since + 30_000; t += 8) {
            const b = walkers(lw, many, sc, t).boss;
            if (b.pose === 'seated') continue;
            assert.ok(!blocked(b, BOSS_FEET), `${width} ${alias} at ${t}: ${JSON.stringify(b)}`);
            if (inside(/** @type {import('../dashboard/layout.js').Rect} */ (lw.doorways.review), b.x + 4, b.y + BOSS_FEET - 1)) through++;
          }
          assert.ok(through > 0, `${alias}: through the Review room's doorway`);
        }
      }
    }
  });

  it('reaches the worker\'s shoulder, behind the desk, and only then reads', () => {
    const sc = going('a');
    const there = arrival(sc);
    assert.ok(there > since + 3000, 'a walk across the office takes a while');
    assert.equal(look(sc, there - 1).boss.pose, 'walking');
    const b = look(sc, there).boss;
    assert.equal(b.pose, 'standing');
    const d = deskAt(l, many, cube('a'));
    const w = workerRect(d);
    assert.ok(b.x > w.x && b.x - w.x <= 12, 'at the worker\'s side');
    assert.equal(b.y + BOSS_FEET, d.y - 1, 'standing just behind the desk');
    for (let t = since; t < there; t += 50) assert.equal(look(sc, t).boss.pose, 'walking', `still walking at ${t}`);
    assert.deepEqual(look(sc, there + 60_000).boss, b);
  });

  it('takes longer to reach a farther cubicle', () => {
    // the Review room is on the left: a is the front row's leftmost cubicle, d its rightmost, f behind
    const [a, d, f] = ['a', 'd', 'f'].map((alias) => arrival(going(alias)));
    assert.ok(a < d, `a ${a} before d ${d}`);
    assert.ok(a < f, `a ${a} before f ${f}`);
  });

  it('walks back and is seated at home', () => {
    const sc = returning('d');
    const back = arrival(sc);
    assert.equal(back - since, arrival(going('d')) - since, 'the same way back');
    assert.equal(look(sc, back - 1).boss.pose, 'walking');
    assert.deepEqual(look(sc, back).boss, home);
    assert.equal(home.pose, 'seated');
  });

  it('shows the boss partway along the route when the page looks mid-walk', () => {
    const sc = going('d');
    const there = arrival(sc);
    const start = look(sc, since).boss;
    const mid = look(sc, Math.floor((since + there) / 2)).boss;
    const end = look(sc, there).boss;
    assert.equal(mid.pose, 'walking');
    assert.notDeepEqual([mid.x, mid.y], [start.x, start.y]);
    assert.notDeepEqual([mid.x, mid.y], [end.x, end.y]);
    assert.ok(Math.abs(mid.x - start.x) + Math.abs(mid.y - start.y) > 20, 'well on the way');
  });

  it('faces the way they walk', () => {
    const sc = returning('d');
    const back = arrival(sc);
    let [left, right] = [0, 0];
    for (let t = since; t < back; t += 40) {
      const [b, next] = [look(sc, t).boss, look(sc, t + 40).boss];
      if (next.pose !== 'walking' || next.y !== b.y || next.x === b.x) continue;
      if (next.x < b.x) left++;
      else right++;
      assert.equal(next.facing, next.x < b.x ? 'left' : 'right', `at ${t}`);
    }
    assert.ok(left > 0 && right > 0, 'walks both ways');
  });

  it('stays seated at home when the layout has neither end of the walk', () => {
    const sc = scene({ cubicles: many, boss: { at: null, from: cube('gone'), since } });
    for (const t of [since - 1, since, since + 1000, since + 60_000]) assert.deepEqual(look(sc, t).boss, home, `at ${t}`);
    assert.equal(look(sc, since + 1).animating, false);
  });

  it('keeps the page animating for the walk, then stops', () => {
    const sc = returning('f');
    const back = arrival(sc);
    assert.ok(back - since > 2400, 'longer than the old fixed walk');
    assert.equal(look(sc, back - 1).animating, true);
    assert.equal(look(sc, back).animating, false);
  });
});

describe('office walkers: a freeform worker moving desks', () => {
  const since = 20_000;
  const from = { room: /** @type {const} */ ('freeform') };
  const moving = scene({ run: run({ moved: { from, since } }) });
  /** When the worker sits down. @param {Scene} sc @param {number} after */
  const seated = (sc, after) => firstWhen((t) => at(sc, t).worker?.pose === 'seated' && at(sc, t).worker?.x === workerRect(desk).x, after);

  it('stays at the Freeform room\'s desk until the move, then ends at the cubicle seat', () => {
    const before = at(moving, since - 1).worker;
    const seat = workerRect(layout.desks.freeform);
    assert.deepEqual([before.pose, before.x, before.y], ['seated', seat.x, seat.y]);
    const start = at(moving, since + 1).worker;
    assert.deepEqual([start.pose, start.pile], ['walking', 3]);
    assert.ok(Math.abs(start.x - seat.x) <= 2 && Math.abs(start.y - seat.y) <= 6, 'standing up from their seat');
    const sat = seated(moving, since);
    assert.ok(sat - since > 2400, 'across the office takes a while');
    assert.equal(at(moving, sat - 1).worker.pose, 'walking');
    const to = workerRect(desk);
    const end = at(moving, sat).worker;
    assert.deepEqual([end.pose, end.x, end.y], ['seated', to.x, to.y]);
    assert.deepEqual(end.at, BOT);
    assert.equal(at(moving, sat).animating, true, 'the run is still on the floor');
  });

  it('is never inside a wall, partition or desk, and out through the Freeform room\'s doorway', () => {
    for (const width of [560, 720]) {
      const l = layoutOffice(cubicles.length, 'wide', width);
      const blocked = solidWithDesks(l, cubicles);
      let through = 0;
      for (let t = since; t <= since + 30_000; t += 8) {
        const w = walkers(l, cubicles, moving, t).worker;
        if (w.pose !== 'walking') continue;
        assert.ok(!blocked(w, WORKER_FEET), `${width} at ${t}: ${JSON.stringify(w)}`);
        if (inside(/** @type {import('../dashboard/layout.js').Rect} */ (l.doorways.freeform), w.x + 4, w.y + WORKER_FEET - 1)) through++;
      }
      assert.ok(through > 0, 'through the doorway');
    }
  });

  it('faces left while heading left', () => {
    let left = 0;
    for (let t = since; t < since + 30_000; t += 40) {
      const [w, next] = [at(moving, t).worker, at(moving, t + 40).worker];
      if (next.pose !== 'walking' || next.y !== w.y || next.x === w.x) continue;
      if (next.x < w.x) left++;
      assert.equal(next.facing, next.x < w.x ? 'left' : 'right', `at ${t}`);
    }
    assert.ok(left > 0, 'the Freeform room is on the right: they head left');
  });

  it('waits for the hand-over in the Freeform room before moving', () => {
    const early = scene({ run: run({ moved: { from, since: 0 } }) });
    const arrive = arrival(early);
    const seat = workerRect(layout.desks.freeform);
    const handed = at(early, arrive).worker;
    assert.deepEqual([handed.pose, handed.x, handed.y], ['seated', seat.x, seat.y], 'delivered to the Freeform room');
    assert.equal(at(early, arrive + HAND_MS - 1).worker.pose, 'seated');
    assert.equal(at(early, arrive + HAND_MS + 1).worker.pose, 'walking');
    const sat = seated(early, arrive + HAND_MS);
    assert.deepEqual(at(early, sat).worker.at, BOT);
  });

  it('stays at the Freeform room\'s desk when there is no way to the new one', () => {
    const lost = scene({ run: run({ place: { room: 'cubicle', alias: 'gone' }, moved: { from, since } }) });
    const seat = workerRect(layout.desks.freeform);
    for (const t of [since - 1, since + 1, since + 60_000]) {
      const w = at(lost, t).worker;
      assert.deepEqual([w.pose, w.x, w.y, w.at], ['seated', seat.x, seat.y, from], `at ${t}`);
    }
  });
});

describe('office walkers: the narrow layout\'s lane', () => {
  /** @type {import('../dashboard/scene.js').SceneJobDesk} */
  const backup = { name: 'backup', worker: 'clerk', at: '03:00', nextDueAt: null };
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => ({ ...cubicles[0], alias, name: alias, jobs: alias === 'f' ? [backup] : [] }));
  const since = 20_000;
  /** @param {string} alias @param {string} [job] @returns {import('../dashboard/scene.js').Place} */
  const cube = (alias, job) => ({ room: 'cubicle', alias, ...(job ? { job } : {}) });
  /** @type {import('../dashboard/scene.js').Place[]} */
  const places = [cube('a'), cube('c'), cube('d'), cube('f'), cube('f', 'backup'), { room: 'freeform' }, { room: 'joplin' }];
  /** @param {import('../dashboard/scene.js').Place} place */
  const delivering = (place) => scene({ cubicles: many, run: run({ place, delivery: { by: 'envelope', at: 0 } }) });
  /** @param {import('../dashboard/scene.js').Place} place */
  const bossGoing = (place) => scene({ cubicles: many, run: run({ place, postRun: true, work: 'reviewed' }), boss: { at: place, from: null, since } });
  /** @param {import('../dashboard/scene.js').Place} place */
  const bossReturning = (place) => scene({ cubicles: many, boss: { at: null, from: place, since } });
  /** @param {import('../dashboard/scene.js').Place} place */
  const moving = (place) => scene({ cubicles: many, run: run({ place, moved: { from: { room: 'freeform' }, since } }) });
  /** @param {import('../dashboard/layout.js').Layout} l */
  const look = (l) => (/** @type {Scene} */ sc, /** @type {number} */ t) => walkers(l, sc.cubicles, sc, t);
  /** @param {import('../dashboard/layout.js').Layout} l @param {{ x: number, y: number }} feet */
  const inDoorway = (l, feet) => Object.values(l.doorways).some((d) => inside(d, feet.x + 4, feet.y - 1));

  for (const width of [240, 360]) {
    const l = layoutOffice(many.length, 'narrow', width);
    const blocked = solidWithDesks(l, many);

    it(`has the carrier never inside a wall, partition or desk, out through a doorway and down the lane (${width})`, () => {
      for (const place of places) {
        const sc = delivering(place);
        const arrive = arrival(sc, look(l));
        let [passed, laned] = [0, 0];
        for (let t = 1; t < 2 * arrive + HAND_MS; t += 8) {
          const c = look(l)(sc, t).carrier;
          assert.equal(c.pose, 'walking');
          assert.ok(!blocked(c, 0), `${JSON.stringify(place)} at ${t}: ${JSON.stringify(c)}`);
          if (inDoorway(l, c)) passed++;
          if (inside(l.corridors[0], c.x + 4, c.y - 1)) laned++;
        }
        assert.ok(passed > 0 && laned > 0, `${JSON.stringify(place)}: out through a doorway and along the lane`);
      }
    });

    it(`has the boss never inside a wall, partition or desk, there and back (${width})`, () => {
      for (const place of places.filter((p) => p.room === 'cubicle')) {
        for (const sc of [bossGoing(place), bossReturning(place)]) {
          const end = firstWhen((t) => look(l)(sc, t).boss.pose !== 'walking', since);
          assert.equal(look(l)(sc, end).boss.pose, sc.boss.at ? 'standing' : 'seated');
          let through = 0;
          for (let t = since; t < end; t += 8) {
            const b = look(l)(sc, t).boss;
            assert.ok(!blocked(b, BOSS_FEET), `${JSON.stringify(place)} at ${t}: ${JSON.stringify(b)}`);
            if (inside(/** @type {import('../dashboard/layout.js').Rect} */ (l.doorways.review), b.x + 4, b.y + BOSS_FEET - 1)) through++;
          }
          assert.ok(through > 0, `${JSON.stringify(place)}: through the Review room's doorway`);
        }
      }
    });

    it(`has a worker moving desks never inside a wall, partition or desk (${width})`, () => {
      for (const place of places.filter((p) => p.room === 'cubicle')) {
        const sc = moving(place);
        const end = firstWhen((t) => look(l)(sc, t).worker?.at?.room === 'cubicle', since);
        let through = 0;
        for (let t = since; t < end; t += 8) {
          const w = look(l)(sc, t).worker;
          if (w?.pose !== 'walking') continue;
          assert.ok(!blocked(w, WORKER_FEET), `${JSON.stringify(place)} at ${t}: ${JSON.stringify(w)}`);
          if (inside(/** @type {import('../dashboard/layout.js').Rect} */ (l.doorways.freeform), w.x + 4, w.y + WORKER_FEET - 1)) through++;
        }
        assert.ok(through > 0, `${JSON.stringify(place)}: through the Freeform room's doorway`);
        const sat = look(l)(sc, end).worker;
        assert.deepEqual([sat?.pose, sat?.at], ['seated', place]);
      }
    });
  }

  describe('resizing wide ↔ narrow mid-walk', () => {
    const wideL = layoutOffice(many.length, 'wide', 640);
    const narrowL = layoutOffice(many.length, 'narrow', 300);
    /**
     * How far along the walk (0..1) a walker is at `t`, by the length walked on the layout's route:
     * sampled from `start` to `end`, where they stop.
     * @param {(t: number) => { x: number, y: number }} pos @param {number} start @param {number} end @param {number} t
     */
    function fractionAt(pos, start, end, t) {
      let [walked, total] = [0, 0];
      for (let u = start; u < end; u += 2) {
        const [a, b] = [pos(u), pos(Math.min(end, u + 2))];
        const step = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
        total += step;
        if (u < t) walked += step;
      }
      return walked / total;
    }

    it('puts the carrier at the same fraction of the new route, arriving when they would have', () => {
      const sc = delivering(cube('d'));
      const arrive = arrival(sc, look(wideL));
      assert.equal(arrival(sc, look(narrowL)), arrive, 'the same arrival, whichever layout');
      for (const f of [0.25, 0.5, 0.75]) {
        const t = Math.round(arrive * f);
        for (const l of [wideL, narrowL]) {
          const got = fractionAt((u) => look(l)(sc, u).carrier, 0, arrive, t);
          assert.ok(Math.abs(got - f) < 0.02, `${l.width}: ${got} of the way at ${f}`);
        }
      }
      const [w, n] = [wideL, narrowL].map((l) => look(l)(sc, Math.round(arrive / 2)).carrier);
      assert.notDeepEqual([w.x, w.y], [n.x, n.y], 'on a different route');
    });

    it('puts the boss and a moving worker at the same fraction of the new route', () => {
      const bossSc = bossGoing(cube('d'));
      const bossThere = (/** @type {import('../dashboard/layout.js').Layout} */ l) => firstWhen((t) => look(l)(bossSc, t).boss.pose !== 'walking', since);
      const there = bossThere(wideL);
      assert.equal(bossThere(narrowL), there);
      const t = Math.round((since + there) / 2);
      for (const l of [wideL, narrowL]) {
        const got = fractionAt((u) => look(l)(bossSc, u).boss, since, there, t);
        assert.ok(Math.abs(got - 0.5) < 0.02, `boss ${l.width}: ${got}`);
      }
      const moveSc = moving(cube('d'));
      const seated = (/** @type {import('../dashboard/layout.js').Layout} */ l) => firstWhen((u) => look(l)(moveSc, u).worker?.at?.room === 'cubicle', since + 1);
      const sat = seated(wideL);
      assert.equal(seated(narrowL), sat);
      const start = Math.max(since, arrival(moveSc, look(wideL)) + HAND_MS);
      const mid = Math.round((start + sat) / 2);
      for (const l of [wideL, narrowL]) {
        const got = fractionAt((u) => look(l)(moveSc, u).worker, start, sat, mid);
        assert.ok(Math.abs(got - 0.5) < 0.02, `worker ${l.width}: ${got}`);
      }
    });

    it('times every walk the same on every layout, wide or narrow, at any width', () => {
      const layouts = [
        ...[560, 640, 720].map((w) => layoutOffice(many.length, 'wide', w)),
        ...[240, 300, 360].map((w) => layoutOffice(many.length, 'narrow', w)),
      ];
      for (const place of places) {
        const sc = delivering(place);
        const arrivals = layouts.map((l) => arrival(sc, look(l)));
        assert.deepEqual(new Set(arrivals).size, 1, `delivery to ${JSON.stringify(place)}: ${arrivals}`);
      }
      for (const place of places.filter((p) => p.room === 'cubicle')) {
        for (const sc of [bossGoing(place), bossReturning(place), moving(place)]) {
          const stops = layouts.map((l) =>
            sc.run?.moved
              ? firstWhen((u) => look(l)(sc, u).worker?.at?.room === 'cubicle', since + 1)
              : firstWhen((u) => look(l)(sc, u).boss.pose !== 'walking', since),
          );
          assert.deepEqual(new Set(stops).size, 1, `${JSON.stringify(place)}: ${stops}`);
        }
      }
    });
  });
});

describe('office walkers: animating', () => {
  it('is still once every walk is over and nothing on the floor moves', () => {
    const since = 5000;
    const sc = scene({ boss: { at: null, from: BOT, since } });
    const back = firstWhen((t) => at(sc, t).boss.pose === 'seated', since);
    assert.equal(at(sc, back - 1).animating, true);
    assert.equal(at(sc, back).animating, false);
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

describe('office walkers: the Doors', () => {
  const since = 5000;
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => ({ ...cubicles[0], alias, name: alias }));
  /** @param {string} alias @returns {import('../dashboard/scene.js').Place} */
  const cube = (alias) => ({ room: 'cubicle', alias });
  /** The run over, the boss setting off back from `alias`'s cubicle at `since`. @param {string} alias */
  const returning = (alias) => scene({ cubicles: many, boss: { at: null, from: cube(alias), since } });
  /** Where the boss's feet are. @param {ReturnType<typeof walkers>['boss']} b */
  const feet = (b) => ({ x: b.x + 4, y: b.y + BOSS_FEET - 1 });
  /** The first t from `from` (in steps of 5ms) at which `holds`. @param {(t: number) => boolean} holds @param {number} from */
  const scan = (holds, from) => {
    for (let t = from; t < from + 60_000; t += 5) if (holds(t)) return t;
    assert.fail('it happens');
  };

  for (const mode of /** @type {const} */ (['wide', 'narrow'])) {
    describe(mode, () => {
      const l = layoutOffice(many.length, mode, mode === 'wide' ? 640 : 300);
      /** @param {Scene} sc @param {number} t */
      const look = (sc, t) => walkers(l, sc.cubicles, sc, t);
      const sc = returning('d');
      const home = firstWhen((t) => look(sc, t).boss.pose === 'seated', since);
      const review = /** @type {import('../dashboard/layout.js').Rect} */ (l.doorways.review);
      const through = scan((t) => inside(review, feet(look(sc, t).boss).x, feet(look(sc, t).boss).y), since);

      it('has a Door per side room, all shut with nobody walking', () => {
        assert.deepEqual(look(scene({ cubicles: many }), 1e9).doors, { review: 0, joplin: 0, freeform: 0, queueRoom: 0 });
      });

      it('is closed before the boss gets near, open while they pass through, and closed again a moment after', () => {
        assert.equal(look(sc, since).doors.review, 0, 'shut while the boss is across the office');
        assert.equal(look(sc, through).doors.review, 1, 'wide open in the doorway');
        const opening = scan((t) => look(sc, t).doors.review > 0, since);
        assert.ok(through - opening > 100, 'swings open as they come near');
        const shut = scan((t) => look(sc, t).doors.review === 0, through);
        assert.ok(shut - through > 100 && shut - through < 1500, `closes a moment after: ${shut - through}ms`);
        assert.equal(look(sc, shut).boss.pose, 'walking', 'shut behind them before they sit down');
        for (const t of [since, through, shut]) assert.equal(look(sc, t).doors.joplin, 0, 'the other Doors stay shut');
      });

      it('keeps the office animating while a Door closes, and stops once every Door is shut', () => {
        const closing = scan((t) => look(sc, t).doors.review < 1, through);
        assert.ok(look(sc, closing).doors.review > 0, 'swinging shut');
        assert.equal(look(sc, closing).animating, true);
        assert.ok(Object.values(look(sc, home).doors).every((v) => v === 0));
        assert.equal(look(sc, home).animating, false);
      });

      it('opens the Queue room\'s Door for the mail carrier, and the Freeform room\'s', () => {
        const sc2 = scene({ cubicles: many, run: run({ place: { room: 'freeform' }, delivery: { by: 'envelope', at: 0 } }) });
        let [queue, freeform] = [0, 0];
        for (let t = 0; t < 30_000; t += 20) {
          const { doors } = look(sc2, t);
          queue = Math.max(queue, doors.queueRoom ?? 0);
          freeform = Math.max(freeform, doors.freeform ?? 0);
        }
        assert.deepEqual([queue, freeform], [1, 1]);
      });

      it('leaves shut the Doors a walk only goes past', () => {
        const sc2 = scene({ cubicles: many, run: run({ place: { room: 'joplin' }, delivery: { by: 'envelope', at: 0 } }) });
        const sc3 = scene({ cubicles: many, run: run({ place: cube('f'), delivery: { by: 'envelope', at: 0 } }) });
        for (let t = 0; t < 30_000; t += 20) {
          const { doors } = look(sc2, t);
          assert.deepEqual([doors.review, doors.freeform], [0, 0], `to the Joplin room, at ${t}`);
          assert.equal(look(sc3, t).doors.review, 0, `to cubicle f, at ${t}`);
          assert.equal(look(sc, since + t).doors.freeform, 0, `the boss back to the Review room, at ${since + t}`);
        }
      });
    });
  }
});
