import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BREAK_EVERY_MS, CLAP_MS, LINGER_MS, POSE_MS, breaks, dayPart, neighbours, residentsIn, restingPose } from '../dashboard/ambient.js';
import { deskAt, layoutOffice, workerRect } from '../dashboard/layout.js';
import { WORKER_FEET, walkers } from '../dashboard/walkers.js';

/** @typedef {import('../dashboard/scene.js').Scene} Scene */
/** @typedef {import('../dashboard/scene.js').SceneCubicle} SceneCubicle */
/** @typedef {import('../dashboard/scene.js').SceneOutcome} SceneOutcome */

const HOUR = 3_600_000;
/** 1970-01-02 at `h` o'clock UTC. @param {number} h */
const at = (h) => 24 * HOUR + h * HOUR;
const NOON = at(12);

/** @param {string} alias @param {Partial<SceneCubicle>} [over] @returns {SceneCubicle} */
const cube = (alias, over = {}) => ({ alias, name: alias, workspace: true, doNotDisturb: false, inTray: [], sticky: [], jobs: [], quiet: false, ...over });
const cubicles = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => cube(alias));
const layout = layoutOffice(cubicles.length, 'wide', 640);

/** A lit scene with nothing going on, and `over` on top. @param {Partial<Scene>} [over] @returns {Scene} */
const scene = (over = {}) => ({
  dark: false,
  backInFive: false,
  cubicles,
  queueRoom: { countdownMs: null, letters: [] },
  run: null,
  boss: { at: null, from: null, since: 0 },
  outcomes: [],
  parked: [],
  mail: [],
  trayKnown: null,
  helpers: [],
  ...over,
});

/** @param {string} alias @param {Partial<SceneOutcome>} over @returns {SceneOutcome} */
const outcome = (alias, over) => ({ place: { room: 'cubicle', alias }, state: 'stamped', quick: false, runId: 'r0', label: null, outcome: '', recorded: '', endedAt: NOON, prUrl: null, ...over });

/** With ambient life, on UTC. @param {Scene} sc @param {number} t */
const life = (sc, t) => walkers(layout, sc.cubicles, sc, t, { ambient: { tzOffsetMin: 0 } });

/** Every `step` ms over `span` from `from`. @param {number} from @param {number} span @param {number} step */
const times = (from, span, step) => Array.from({ length: Math.floor(span / step) }, (_, i) => from + i * step);

describe('ambient life: the time of day', () => {
  it('is night from 22:00 to 07:00, morning to 09:00, day to 18:00, then evening', () => {
    assert.deepEqual([6, 7, 8, 9, 17, 18, 21, 22, 0].map((h) => dayPart(at(h), 0)), ['night', 'morning', 'morning', 'day', 'day', 'evening', 'evening', 'night', 'night']);
  });

  it("goes by the viewer's clock", () => {
    // 21:00 UTC is 23:00 two hours east (offset -120), and 16:00 five hours west (offset 300)
    assert.equal(dayPart(at(21), -120), 'night');
    assert.equal(dayPart(at(21), 300), 'day');
  });
});

describe('ambient life: who is in', () => {
  it('has a resident per workspace cubicle by day, none at night or with the lights out', () => {
    const sc = scene({ cubicles: [...cubicles, cube('jobs', { workspace: false })] });
    assert.deepEqual(residentsIn(sc, 'day', false), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(residentsIn(sc, 'night', false), []);
    assert.deepEqual(residentsIn({ ...sc, dark: true }, 'day', false), []);
  });

  it("gives up the seat to the run's worker once they're on the floor", () => {
    /** @type {Scene['run']} */
    const run = { runId: 'r1', label: null, activity: null, place: { room: 'cubicle', alias: 'b' }, worker: null, delivery: { by: 'phone', at: 0 }, work: 'typing', pile: 0, bubble: null, postRun: false, moved: null };
    assert.ok(residentsIn(scene({ run }), 'day', false).includes('b'), 'idling until the carrier arrives');
    assert.ok(!residentsIn(scene({ run }), 'day', true).includes('b'));
  });

  it("stays away while the cubicle's last run has its worker at the desk, or gone home", () => {
    const sc = scene({ outcomes: [outcome('a', { state: 'injured' }), outcome('b', { state: 'home' }), outcome('c', { state: 'stamped' }), outcome('d', { state: 'asleep', place: { room: 'cubicle', alias: 'd', job: 'nightly' } })] });
    assert.deepEqual(residentsIn(sc, 'day', false), ['c', 'd', 'e', 'f']);
  });
});

describe('ambient life: breaks', () => {
  const walkMs = () => 5000;
  const present = cubicles.map((c) => c.alias);
  const day = times(NOON, 20 * 60_000, 1000);

  it('sends someone on a break now and then, never more than two at once', () => {
    let busy = 0;
    for (const t of day) {
      const now = breaks(scene(), present, t, walkMs);
      assert.ok(now.length <= 2, `${now.length} at ${t}`);
      if (now.length) busy++;
    }
    assert.ok(busy > day.length / 5, `breaks ${busy} of ${day.length} seconds`);
  });

  it('goes to the water cooler, the bookshelf and the neighbours, and picks different people', () => {
    const all = day.flatMap((t) => breaks(scene(), present, t, walkMs));
    assert.deepEqual(new Set(all.map((b) => b.to.kind)), new Set(['cooler', 'books', 'chat']));
    assert.ok(new Set(all.map((b) => b.alias)).size >= 4);
  });

  it('never has anyone in two places, nor chatting with themselves', () => {
    for (const t of day) {
      const people = breaks(scene(), present, t, walkMs).flatMap((b) => {
        if (b.to.kind === 'chat') assert.notEqual(b.to.alias, b.alias);
        return [b.alias, ...(b.to.kind === 'chat' ? [b.to.alias] : [])];
      });
      assert.equal(new Set(people).size, people.length, `at ${t}`);
    }
  });

  it('is the same on every page, and lasts a walk each way and the linger', () => {
    const t = day.find((x) => breaks(scene(), present, x, walkMs).length);
    assert.ok(t);
    assert.deepEqual(breaks(scene(), present, t, walkMs), breaks(scene(), present, t, walkMs));
    for (const b of breaks(scene(), present, t, walkMs)) {
      assert.equal(b.linger, LINGER_MS);
      assert.ok(b.start <= t && t < b.start + 2 * b.walk + b.linger);
    }
  });

  it('leaves Do Not Disturb alone, and skips a break with no way there', () => {
    const sc = scene({ cubicles: cubicles.map((c) => (c.alias === 'a' ? c : { ...c, doNotDisturb: true })) });
    for (const t of day) for (const b of breaks(sc, present, t, walkMs)) assert.deepEqual([b.alias, b.to.kind === 'chat'], ['a', false]);
    for (const t of times(NOON, 5 * BREAK_EVERY_MS, 1000)) assert.deepEqual(breaks(scene(), present, t, () => null), []);
  });
});

describe('ambient life: poses', () => {
  const beside = neighbours(layout, cubicles);
  /** Each pose over many slots. @param {SceneCubicle} c @param {Scene} sc @param {string | null} runAt */
  const poses = (c, sc, runAt = null) => times(NOON, 400 * POSE_MS, POSE_MS).map((t) => restingPose(c, sc, t, beside.get(c.alias) ?? { left: null, right: null }, runAt).pose);
  /** @param {string[]} ps @param {string} pose */
  const share = (ps, pose) => ps.filter((p) => p === pose).length / ps.length;

  it('knows who sits next to whom, row by row', () => {
    // 640 wide: 4 to a row, so d's right and e's left are the end of a row
    assert.deepEqual(beside.get('a'), { left: null, right: 'b' });
    assert.deepEqual(beside.get('d'), { left: 'c', right: null });
    assert.deepEqual(beside.get('e'), { left: null, right: 'f' });
  });

  it('fidgets, mostly sitting still', () => {
    const ps = poses(cubicles[0], scene());
    assert.ok(share(ps, 'still') > 0.4);
    for (const p of /** @type {const} */ (['sip', 'lean', 'look', 'stretch'])) assert.ok(ps.includes(p), p);
    assert.ok(!ps.includes('peek') && !ps.includes('sort'));
  });

  it('dozes off far more in a quiet cubicle', () => {
    assert.ok(share(poses(cube('a', { quiet: true }), scene()), 'doze') > 0.3);
    assert.ok(share(poses(cubicles[0], scene()), 'doze') < 0.1);
  });

  it('flicks through the in-tray while it has letters', () => {
    assert.ok(poses(cube('a', { inTray: [{ number: 1, title: 'x', blocked: false }] }), scene()).includes('sort'));
  });

  it('peers at the run next door, facing it', () => {
    const ps = times(NOON, 100 * POSE_MS, POSE_MS).map((t) => restingPose(cubicles[0], scene(), t, beside.get('a') ?? { left: null, right: null }, 'b'));
    assert.ok(ps.some((p) => p.pose === 'peek'));
    for (const p of ps.filter((x) => x.pose === 'peek')) assert.equal(p.facing, 'right');
    assert.ok(!poses(cubicles[0], scene(), 'c').includes('peek'), 'not two doors down');
  });

  it('cheers a merge in their cubicle and claps one next door, for CLAP_MS', () => {
    const sc = scene({ outcomes: [outcome('b', { endedAt: NOON })] });
    /** @param {string} alias @param {number} t */
    const pose = (alias, t) => restingPose(cube(alias), sc, t, beside.get(alias) ?? { left: null, right: null }, null);
    assert.deepEqual(pose('b', NOON + 1000).pose, 'cheer');
    assert.deepEqual(pose('a', NOON + 1000), { pose: 'clap', facing: 'right' });
    assert.deepEqual(pose('c', NOON + 1000), { pose: 'clap', facing: 'left' });
    assert.notEqual(pose('d', NOON + 1000).pose, 'clap');
    assert.notEqual(pose('a', NOON + CLAP_MS).pose, 'clap');
  });
});

describe('ambient life: on the floor', () => {
  it('is off unless asked for', () => {
    const w = walkers(layout, cubicles, scene(), NOON);
    assert.deepEqual([w.residents, w.strollers, w.janitor, w.part, w.animating], [[], [], null, 'day', false]);
  });

  it('seats every resident not on a break, and keeps the office animating', () => {
    for (const t of times(NOON, 5 * 60_000, 1000)) {
      const w = life(scene(), t);
      const out = w.strollers.map((s) => s.alias);
      assert.deepEqual([...w.residents.map((r) => r.alias), ...out].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
      assert.equal(w.animating, true);
    }
  });

  it('walks a break from the seat and back to it, on foot over the floor', () => {
    const t = times(NOON, 10 * 60_000, 250).find((x) => life(scene(), x).strollers.some((s) => s.pose === 'walking'));
    assert.ok(t, 'someone takes a break');
    const s = life(scene(), t).strollers[0];
    const desk = /** @type {import('../dashboard/layout.js').Rect} */ (deskAt(layout, cubicles, { room: 'cubicle', alias: s.alias }));
    // follow them till they're seated again
    let last = t;
    while (life(scene(), last).strollers.some((x) => x.alias === s.alias)) last += 250;
    const before = life(scene(), last - 250).strollers.find((x) => x.alias === s.alias);
    assert.ok(before);
    // a quarter second short of it, at walking pace (60px/s)
    assert.ok(Math.abs(before.x - workerRect(desk).x) + Math.abs(before.y + WORKER_FEET - (desk.y - 1)) <= 15, 'back at their seat');
    assert.ok(life(scene(), last).residents.some((r) => r.alias === s.alias), 'and sitting down');
  });

  it('has the one being visited chat back', () => {
    const t = times(NOON, 60 * 60_000, 1000).find((x) => life(scene(), x).strollers.some((s) => s.pose === 'standing' && s.to.kind === 'chat'));
    assert.ok(t, 'someone pays a visit');
    const w = life(scene(), t);
    const visit = w.strollers.find((s) => s.pose === 'standing' && s.to.kind === 'chat');
    const host = visit?.to.kind === 'chat' ? visit.to.alias : null;
    assert.equal(w.residents.find((r) => r.alias === host)?.pose, 'chat');
  });

  it('sends everyone home at night and brings the janitor in, mopping the aisles', () => {
    const w = life(scene(), at(23));
    assert.deepEqual([w.part, w.residents, w.strollers], ['night', [], []]);
    assert.ok(w.janitor);
    const lanes = layout.aisles.map((a) => a.y + a.h - 3);
    for (const t of times(at(23), 60_000, 2000)) {
      const j = /** @type {NonNullable<ReturnType<typeof life>['janitor']>} */ (life(scene(), t).janitor);
      const y = j.y + WORKER_FEET;
      assert.ok(lanes.includes(y) || (y >= lanes[0] && y <= lanes[lanes.length - 1]), `on an aisle or the corridor: ${y}`);
    }
    assert.equal(life(scene(), NOON).janitor, null);
  });

  it('has the boss pace while PRs are parked, and sit otherwise', () => {
    const parked = [{ alias: 'a', number: 1, title: 'x', prUrl: 'u' }];
    const paced = times(NOON, 20_000, 500).map((t) => life(scene({ parked }), t).boss);
    assert.ok(paced.some((b) => b.pose === 'walking'));
    assert.ok(paced.some((b) => b.pose === 'seated'));
    assert.ok(new Set(paced.map((b) => b.x)).size > 3, 'to and fro');
    assert.ok(times(NOON, 20_000, 500).every((t) => life(scene(), t).boss.pose === 'seated'));
  });
});

describe('ambient life: colleagues helping with subagents', () => {
  /** @type {Scene['run']} */
  const run = { runId: 'r1', label: null, activity: null, place: { room: 'cubicle', alias: 'b' }, worker: null, delivery: { by: 'envelope', at: NOON - 60_000 }, work: 'typing', pile: 0, bubble: null, postRun: false, moved: null };
  /** @param {string} id @param {number} slot @param {Partial<Scene['helpers'][number]>} [over] @returns {Scene['helpers'][number]} */
  const helper = (id, slot, over = {}) => ({ id, description: `Task ${id}`, activity: 'Bash: ls', slot, place: { room: 'cubicle', alias: 'b' }, since: NOON, until: null, ...over });
  const at2 = (sc, t) => life(sc, t);

  it('recruits the nearest residents, left first, who leave their desks to walk over', () => {
    const sc = scene({ run, helpers: [helper('x', 0), helper('y', 1)] });
    const w = at2(sc, NOON + 500);
    assert.deepEqual(w.helpers.map((h) => [h.recruit, h.pose]), [['a', 'walking'], ['c', 'walking']]);
    assert.ok(!w.residents.some((r) => r.alias === 'a' || r.alias === 'c'), 'away from their desks');
    assert.ok(!w.strollers.some((s) => s.alias === 'a' || s.alias === 'c'), 'and not on a break');
  });

  it('stands them at the run\'s desk facing the worker while the subagent runs, then walks them back to their seats', () => {
    const working = scene({ run, helpers: [helper('x', 0)] });
    const there = at2(working, NOON + 60_000).helpers[0];
    assert.equal(there.pose, 'standing');
    assert.equal(there.activity, 'Bash: ls');
    const desk = /** @type {import('../dashboard/layout.js').Rect} */ (deskAt(layout, cubicles, { room: 'cubicle', alias: 'b' }));
    assert.equal(there.facing, there.x > workerRect(desk).x ? 'left' : 'right');
    const done = scene({ run, helpers: [helper('x', 0, { until: NOON + 60_000 })] });
    const back = at2(done, NOON + 61_000).helpers[0];
    assert.deepEqual([back.pose, back.done, back.activity], ['walking', true, null]);
    let t = NOON + 61_000;
    while (at2(done, t).helpers.length) t += 500;
    const w = at2(done, t);
    assert.ok([...w.residents.map((r) => r.alias), ...w.strollers.map((x) => x.alias)].includes('a'), 'back at their desk (or off on a break)');
  });

  it('sends a temp from the Queue room when no resident can come: at night, on Do Not Disturb, or with ambient life off', () => {
    const night = at2(scene({ run, helpers: [helper('x', 0)] }), at(23)).helpers[0];
    assert.equal(night.recruit, null);
    const dnd = scene({ run, helpers: [helper('x', 0, { since: NOON })], cubicles: cubicles.map((c) => (c.alias === 'a' ? { ...c, doNotDisturb: true } : c)) });
    assert.equal(at2(dnd, NOON + 500).helpers[0].recruit, 'c', 'the next nearest instead');
    const off = walkers(layout, cubicles, scene({ run, helpers: [helper('x', 0)] }), NOON + 500);
    assert.equal(off.helpers[0].recruit, null);
  });

  it('opens the doors on a temp\'s way in from the Queue room', () => {
    const sc = scene({ run, helpers: [helper('x', 0, { since: at(23) })] });
    const open = times(at(23), 20_000, 100).some((t) => (at2(sc, t).doors.queueRoom ?? 0) > 0);
    assert.ok(open);
  });
});
