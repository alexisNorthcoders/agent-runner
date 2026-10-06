// Who walks the office floor at a given time, and where: the mail carrier's delivery, the boss's
// walks to a worker's shoulder and back, and a worker moving desks with their papers, all routed
// over the layout's walk graph at a steady pace from the times the scene gives. Also how far each
// side room's Door is open, from how near someone walking is, and whether anything on the floor
// still moves. With ambient life on, also the residents (ambient.js): who sits at their desk in
// what pose, who is out on a break and where, the night janitor, and the boss pacing over parked
// PRs. No DOM here, so it can be tested in Node; officeView.js draws what it returns.
import { breaks, dayPart, neighbours, residentsIn, restingPose } from './ambient.js';
import { SIDE_ROOMS, WIDE_WIDTH, breakSpots, deskAt, deskOwners, inside, layoutOffice, placeKey, walkGraph, workerRect } from './layout.js';

/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./layout.js').Point} Point */
/** @typedef {import('./layout.js').WalkGraph} WalkGraph */
/** @typedef {import('./scene.js').Place} Place */
/** @typedef {import('./scene.js').Scene} Scene */

/**
 * @typedef {{ who: 'carrier', x: number, y: number, pose: 'walking' | 'standing', facing: 'left' | 'right', carrying: 'phone' | 'envelope' | 'mail' | null, still?: boolean }} Carrier
 *   The mail carrier: standing behind the front desk (as the top of their cap, `carrying` the
 *   phone while it rings), or out delivering (as their feet, `carrying` the run until the
 *   hand-over, or the round's `mail` until its last drop), `facing` the way they're heading,
 *   `still` while they stop at a cubicle to drop its letters in the in-tray.
 * @typedef {{ who: 'boss', x: number, y: number, pose: 'walking' | 'standing' | 'seated', facing: 'left' | 'right' }} Boss
 *   The boss, as the top of their head: seated at their desk, walking, or standing at a worker's
 *   shoulder (reading), `facing` the way they're heading (or last headed).
 * @typedef {{ who: 'worker', x: number, y: number, pose: 'walking' | 'seated', facing: 'left' | 'right', pile: number, at: Place | null }} Worker
 *   The active run's worker, as the top of their head: seated at the desk of `at` once the mail
 *   carrier has arrived, or walking to a new desk with their `pile` of papers (`at` null), `facing`
 *   the way they're heading.
 * @typedef {{ who: 'stroller', alias: string, x: number, y: number, pose: 'walking' | 'standing', facing: 'left' | 'right', to: import('./ambient.js').BreakTo }} Stroller
 *   A resident out on a break, as the top of their head: walking there or back, or standing
 *   there (at the water cooler, the bookshelf, or chatting in a neighbour's cubicle).
 * @typedef {{ who: 'janitor', x: number, y: number, pose: 'walking', facing: 'left' | 'right' }} Janitor
 *   The night janitor mopping up and down the aisles, as the top of their head.
 * @typedef {{ alias: string, pose: import('./ambient.js').Pose, facing: 'left' | 'right' }} Resident
 *   A resident seated at their cubicle's own desk, in an idle pose.
 * @typedef {{ who: 'helper', id: string, x: number, y: number, pose: 'walking' | 'standing', facing: 'left' | 'right', recruit: string | null, slot: number, description: string, activity: string | null, done: boolean }} Helper
 *   A colleague helping the active run with a subagent, as the top of their head: the resident
 *   of the `recruit` cubicle, or a temp (null) in from the Queue room; walking over or back, or
 *   standing at the run's desk, with what the subagent is doing (`activity`), till it's `done`.
 * @typedef {Carrier | Boss | Worker | Stroller | Janitor | Helper} Walker
 * @typedef {Partial<Record<import('./layout.js').SideRoomId, number>>} Doors
 *   How far each side room's Door is open, 0 (shut) to 1 (wide open), for each room with a doorway.
 */

/** How long the phone rings before the mail carrier sets off, and the hand-over. */
export const RING_MS = 1600;
export const HAND_MS = 500;
/** Everyone's pace, in scene pixels a second, on the office walks are timed on (timingOffice). */
export const WALK_SPEED = 60;
/** A finished run's stamp coming down, and its papers going to the out tray. */
export const STAMP_MS = 900;
export const TRAY_MS = 900;
/**
 * A Door is wide open while someone walking is within DOOR_NEAR of its doorway, and shut once
 * they're DOOR_FAR away, so it swings open as they come and shut behind them as they go.
 */
const DOOR_NEAR = 8;
const DOOR_FAR = 36;
/**
 * Where the subagents' colleagues stand in front of the run's desk, by slot: across from the
 * worker either side, then a step further forward and out, so their tags don't overlap.
 */
const HELPER_SPOTS = [
  { dx: -14, dy: 0 },
  { dx: 14, dy: 0 },
  { dx: -32, dy: 5 },
  { dx: 32, dy: 5 },
];
/** The janitor's pace, mopping. */
const MOP_SPEED = 18;
/** With PRs parked, the boss paces behind their desk for PACE_MS every PACE_EVERY_MS, this far each way. */
const PACE_EVERY_MS = 20_000;
const PACE_MS = 8000;
const PACE_REACH = 16;
/** Resting states that keep moving: Zzz, stars, the tumbleweed. */
const ANIMATED_STATES = new Set(['asleep', 'dizzy', 'shrug']);

/** @param {number} a @param {number} b @param {number} f 0..1 */
export const lerp = (a, b, f) => Math.round(a + (b - a) * Math.max(0, Math.min(1, f)));

/** Where the mail carrier stands behind the front desk (top of their cap). @param {Layout} layout */
const carrierHome = (layout) => ({ x: layout.desk.x + 30, y: layout.desk.y - 16 });
/** How far below the top of their head the feet are of the boss standing, and of a worker on foot. */
export const BOSS_FEET = 19;
export const WORKER_FEET = 21;
/** Where the boss stands behind their chair (x). @param {Rect} desk the boss's desk */
const bossChair = (desk) => desk.x + 23;
/** Where the boss stands at a worker's shoulder (x). @param {Rect} desk the worker's */
const shoulder = (desk) => workerRect(desk).x + 10;
/** Where a worker stands to sit down at `desk` (x). @param {Rect} desk */
const seat = (desk) => workerRect(desk).x;

/** @param {Point} a @param {Point} b */
const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
/** @param {Point} p */
const pointKey = (p) => `${p.x},${p.y}`;

/** Each walk graph's shortest routes so far, by their ends. @type {WeakMap<WalkGraph, Map<string, Point[]>>} */
const routeCache = new WeakMap();

/**
 * The shortest way over the walk graph from `from` to `to`, as the points to walk through; straight
 * there if the graph doesn't join them.
 * @param {import('./layout.js').WalkGraph} graph @param {Point} from @param {Point} to
 * @returns {Point[]}
 */
function shortestRoute(graph, from, to) {
  let cache = routeCache.get(graph);
  if (!cache) routeCache.set(graph, (cache = new Map()));
  const key = `${pointKey(from)}>${pointKey(to)}`;
  let route = cache.get(key);
  if (!route) cache.set(key, (route = findRoute(graph, from, to)));
  return route;
}

/** @param {import('./layout.js').WalkGraph} graph @param {Point} from @param {Point} to @returns {Point[]} */
function findRoute(graph, from, to) {
  /** @type {Map<string, Array<{ p: Point, d: number }>>} */
  const next = new Map();
  for (const [a, b] of graph.edges) {
    const d = distance(a, b);
    next.set(pointKey(a), [...(next.get(pointKey(a)) ?? []), { p: b, d }]);
    next.set(pointKey(b), [...(next.get(pointKey(b)) ?? []), { p: a, d }]);
  }
  /** @type {Map<string, { d: number, p: Point, prev: string | null }>} */
  const best = new Map([[pointKey(from), { d: 0, p: from, prev: null }]]);
  const done = new Set();
  for (;;) {
    let here = null;
    for (const [k, v] of best) if (!done.has(k) && (!here || v.d < here[1].d)) here = [k, v];
    if (!here) return [from, to];
    const [k, { d }] = here;
    if (k === pointKey(to)) break;
    done.add(k);
    for (const n of next.get(k) ?? []) {
      const seen = best.get(pointKey(n.p));
      if (!seen || d + n.d < seen.d) best.set(pointKey(n.p), { d: d + n.d, p: n.p, prev: k });
    }
  }
  const route = [];
  for (let k = /** @type {string | null} */ (pointKey(to)); k; k = best.get(k)?.prev ?? null) route.unshift(/** @type {{ p: Point }} */ (best.get(k)).p);
  return route;
}

/**
 * The way from in front of a desk (its approach point) round its nearer end to `x` just behind it
 * (feet), where the boss stands at a worker's shoulder or a worker takes their seat. Only an end
 * with room to pass counts: a cubicle's desks side by side leave none between them. Null when the
 * layout doesn't have the desk, or it has no end to pass (a desk between two others).
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {WalkGraph} graph
 * @param {Place | { room: 'review' }} place the desk's, or the boss's own
 * @param {(desk: Rect) => number} spotX where behind the desk to stand
 * @returns {Point[] | null}
 */
function roundDesk(layout, cubicles, graph, place, spotX) {
  const desk = place.room === 'cubicle' ? deskAt(layout, cubicles, place) : layout.desks[place.room];
  const from = graph.approaches.get(place.room === 'cubicle' ? placeKey(place) : place.room);
  if (!desk || !from) return null;
  const spot = { x: spotX(desk), y: desk.y - 1 };
  // just clear of the desk's left end, and of its right end
  let ends = [desk.x - 8, desk.x + desk.w - 2];
  if (place.room === 'cubicle') {
    const c = cubicles.find((cu) => cu.alias === place.alias);
    const owners = c ? deskOwners(c) : [];
    const k = owners.indexOf(place.job ?? null);
    const [left, right] = ends;
    ends = [...(k === 0 ? [left] : []), ...(k === owners.length - 1 ? [right] : [])];
  }
  if (!ends.length) return null;
  const end = ends.reduce((a, b) => (Math.abs(from.x - b) + Math.abs(b - spot.x) < Math.abs(from.x - a) + Math.abs(a - spot.x) ? b : a));
  return [from, { x: end, y: from.y }, { x: end, y: spot.y }, spot];
}

/**
 * From behind one desk to behind another: back round the first desk's end, over the walk graph,
 * and round the second's.
 * @param {WalkGraph} graph @param {Point[]} out roundDesk's way to the first @param {Point[]} into roundDesk's way to the second
 */
const deskToDesk = (graph, out, into) => [...[...out].reverse(), ...shortestRoute(graph, out[0], into[0]).slice(1), ...into.slice(1)];

/** @param {Point[]} route */
const routeLength = (route) => route.slice(1).reduce((n, p, i) => n + distance(route[i], p), 0);

/**
 * Where a walker is `f` (0..1) of the way along `route`, and which way they face: the way the
 * route last went sideways (or next will, at the start), right if it never does.
 * @param {Point[]} route @param {number} f
 * @returns {Point & { facing: 'left' | 'right' }}
 */
function alongRoute(route, f) {
  let togo = routeLength(route) * Math.max(0, Math.min(1, f));
  let i = 0;
  for (; i < route.length - 2 && togo > distance(route[i], route[i + 1]); i++) togo -= distance(route[i], route[i + 1]);
  const [a, b] = [route[i], route[i + 1] ?? route[i]];
  const g = distance(a, b) ? togo / distance(a, b) : 0;
  const steps = route.slice(1).map((p, j) => p.x - route[j].x);
  const dx = [...steps.slice(0, i + 1).reverse(), ...steps.slice(i + 1)].find((d) => d !== 0) ?? 0;
  return { x: lerp(a.x, b.x, g), y: lerp(a.y, b.y, g), facing: dx < 0 ? 'left' : 'right' };
}

/** How long walking `route` takes, in ms. @param {Point[]} route */
const walkMs = (route) => (routeLength(route) / WALK_SPEED) * 1000;

/**
 * The office every walk is timed on, whatever layout it's drawn on: the wide one at its narrowest,
 * with the scene's cubicles. A walk takes as long as its route there at WALK_SPEED, so resizing
 * (wide ↔ narrow, or wider) mid-walk puts the walker the same fraction along the new route, and
 * they arrive when they would have. Every layout of the same cubicles has the same desks (all the
 * rooms' desks, and each cubicle's desk per owner, with the same ends to pass), so a walk has a
 * route here exactly when it has one on the layout it's drawn on.
 * @param {Scene['cubicles']} cubicles
 */
const timingOffice = (cubicles) => {
  const key = deskKey(cubicles);
  let office = timingOffices.get(key);
  if (!office) {
    if (timingOffices.size > 8) timingOffices.clear();
    timingOffices.set(key, (office = layoutOffice(cubicles.length, 'wide', WIDE_WIDTH.min)));
  }
  return office;
};
/** @type {Map<string, Layout>} */
const timingOffices = new Map();

/** The cubicles' desks, as a key. @param {Scene['cubicles']} cubicles */
const deskKey = (cubicles) => cubicles.map((c) => `${c.alias}:${deskOwners(c).join(',')}`).join('|');

/** Each layout's walk graph, for the cubicles it was made for. @type {WeakMap<Layout, { key: string, graph: WalkGraph }>} */
const graphs = new WeakMap();

/** The walk graph of `layout` with `cubicles`, made once. @param {Layout} layout @param {Scene['cubicles']} cubicles */
function graphOf(layout, cubicles) {
  const key = deskKey(cubicles);
  const known = graphs.get(layout);
  if (known?.key === key) return known.graph;
  const graph = walkGraph(layout, cubicles);
  graphs.set(layout, { key, graph });
  return graph;
}

/**
 * The carrier's route from the front desk to the approach point of the desk the run was delivered
 * to (the one a worker who moved desks left). Null when the layout doesn't have that desk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {WalkGraph} graph @param {NonNullable<Scene['run']>} run
 */
function deliveryRoute(layout, cubicles, graph, run) {
  const place = run.moved?.from ?? run.place;
  const to = graph.approaches.get(placeKey(place));
  if (!deskAt(layout, cubicles, place)) return null;
  return to ? shortestRoute(graph, graph.front, to) : [graph.front];
}

/** When the carrier could set off with the run: once the phone has rung, for a manual one. @param {NonNullable<Scene['run']>} run */
const runReady = (run) => run.delivery.at + (run.delivery.by === 'phone' ? RING_MS : 0);

/**
 * The run's delivery: the carrier's route on the current layout, and when they set off (`leave`,
 * once they're free), arrive with the run (the worker is at that desk from then on) and are back
 * in the Queue room.
 * @param {Point[]} route @param {number} walk how long it takes, in ms @param {number} leave
 */
function delivery(route, walk, leave) {
  return { route, walk, leave, arrive: leave + walk, back: leave + 2 * walk + HAND_MS };
}

/**
 * A round of mail's legs on `layout`: from the front desk to each cubicle with letters in turn (the
 * approach to its own desk, by its in-tray), and back. Null when the layout has none of its cubicles.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {import('./scene.js').SceneMail} m
 * @returns {{ legs: Point[][], drops: import('./scene.js').SceneMail['drops'] } | null}
 */
function mailLegs(layout, cubicles, m) {
  const graph = graphOf(layout, cubicles);
  const drops = m.drops.filter((d) => graph.approaches.has(placeKey({ room: 'cubicle', alias: d.alias })));
  if (!drops.length) return null;
  const stops = [graph.front, ...drops.map((d) => /** @type {Point} */ (graph.approaches.get(placeKey({ room: 'cubicle', alias: d.alias })))), graph.front];
  return { legs: stops.slice(1).map((p, i) => shortestRoute(graph, stops[i], p)), drops };
}

/**
 * @typedef {{
 *   id: string, legs: Point[][], starts: number[], walks: number[], leave: number, back: number,
 *   drops: Array<{ alias: string, numbers: number[], at: number }>, route: Point[],
 * }} MailRun
 *   A round of mail on the current layout: each leg setting off at `starts[i]` and taking
 *   `walks[i]` ms (timed on the timing office), each drop made at `at` (halfway through the
 *   carrier's HAND_MS stop there), and the whole round (`route`), for the Doors.
 */

/**
 * The round `m`'s timings once the carrier sets off at `leave`. Null when the layout has none of its cubicles.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {import('./scene.js').SceneMail} m @param {number} leave
 * @returns {MailRun | null}
 */
function mailRun(layout, cubicles, m, leave) {
  const here = mailLegs(layout, cubicles, m);
  const timed = mailLegs(timingOffice(cubicles), cubicles, m);
  if (!here || !timed || timed.legs.length !== here.legs.length) return null;
  const walks = timed.legs.map(walkMs);
  /** @type {number[]} */
  const starts = [];
  /** @type {MailRun['drops']} */
  const drops = [];
  let at = leave;
  here.legs.forEach((_, i) => {
    starts.push(at);
    at += walks[i];
    if (i < here.drops.length) {
      // the letters go in the tray halfway through the stop
      drops.push({ ...here.drops[i], at: at + HAND_MS / 2 });
      at += HAND_MS;
    }
  });
  return { id: m.id, legs: here.legs, starts, walks, leave, back: at, drops, route: here.legs.flat() };
}

/**
 * The carrier on a round of mail at `t` (between its `leave` and `back`): walking a leg, carrying
 * the mail until the last drop, or stopped at a cubicle dropping its letters.
 * @param {MailRun} r @param {number} t
 * @returns {Carrier}
 */
function onRound(r, t) {
  let i = 0;
  while (i + 1 < r.starts.length && r.starts[i + 1] <= t) i++;
  const f = r.walks[i] ? (t - r.starts[i]) / r.walks[i] : 1;
  const p = alongRoute(r.legs[i], f);
  const carrying = i < r.drops.length ? 'mail' : null;
  return { who: 'carrier', x: p.x, y: p.y, pose: 'walking', facing: p.facing, carrying, still: f >= 1 };
}

/**
 * The carrier's day: the active run's delivery and the rounds of mail, each in the order it came
 * in (the run first at a tie), setting off once the carrier is back from the one before (and, for
 * a manual run, once the phone has rung). A
 * delivery is left out once its run is in post-run (it's long over), but still timed, for the worker.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Scene} scene
 * @param {Point[] | null} route the run's delivery route on `layout` @param {number | null} walk its timed walk
 */
function carrierPlan(layout, cubicles, scene, route, walk) {
  const run = scene.run;
  /** @type {Array<{ at: number, ready: number, run: boolean, m?: import('./scene.js').SceneMail }>} */
  const asks = [
    ...scene.mail.map((m) => ({ at: m.at, ready: m.at, run: false, m })),
    ...(run && route && !run.postRun ? [{ at: run.delivery.at, ready: runReady(run), run: true }] : []),
  ];
  asks.sort((a, b) => a.at - b.at || Number(b.run) - Number(a.run));
  let free = -Infinity;
  /** @type {ReturnType<typeof delivery> | null} */
  let trip = run && route && walk != null && run.postRun ? delivery(route, walk, runReady(run)) : null;
  /** @type {MailRun[]} */
  const rounds = [];
  for (const a of asks) {
    const leave = Math.max(a.ready, free);
    if (a.run && run && route && walk != null) {
      trip = delivery(route, walk, leave);
      free = trip.back;
    } else if (a.m) {
      const r = mailRun(layout, cubicles, a.m, leave);
      if (!r) continue;
      rounds.push(r);
      free = r.back;
    }
  }
  return { trip, rounds };
}

/**
 * The in-tray letters the carrier hasn't dropped yet at `t`, by cubicle: hidden from the tray till then.
 * @param {MailRun[]} rounds @param {number} t
 * @returns {Map<string, Set<number>>}
 */
function undeliveredMail(rounds, t) {
  /** @type {Map<string, Set<number>>} */
  const out = new Map();
  for (const r of rounds) {
    for (const d of r.drops) {
      if (t >= d.at) continue;
      const set = out.get(d.alias) ?? new Set();
      for (const n of d.numbers) set.add(n);
      out.set(d.alias, set);
    }
  }
  return out;
}

/**
 * A cubicle's in-tray letters on show at `t`: all but those still in the carrier's bag.
 * @template {{ number: number }} L
 * @param {{ alias: string, inTray: L[] }} c @param {Map<string, Set<number>>} undelivered walkers' own
 * @returns {L[]}
 */
export const trayNow = (c, undelivered) => c.inTray.filter((l) => !undelivered.get(c.alias)?.has(l.number));

/**
 * @typedef {ReturnType<typeof delivery>} Delivery
 * @typedef {{ from: Place, route: Point[], start: number, walk: number }} Move
 *   A freeform run's worker moving desks: their route, and when they set off (once the mail carrier
 *   has handed the run over at the old desk) and how long it takes.
 * @typedef {{ route: Point[], since: number, walk: number, reading: boolean }} BossWalk
 *   The boss's last walk: its route, setting off at `boss.since`, and how long it takes.
 */

/**
 * The mail carrier at `t`: out on a round of mail, out delivering the active run, else behind the
 * front desk (holding the phone while a manual run waits for them).
 * @param {Layout} layout @param {Delivery | null} trip the run's delivery, if the layout has its desk
 * @param {MailRun[]} rounds @param {Scene} scene @param {number} t
 * @returns {Carrier}
 */
function carrier(layout, trip, rounds, scene, t) {
  const run = scene.run;
  const home = { who: /** @type {const} */ ('carrier'), ...carrierHome(layout), pose: /** @type {const} */ ('standing'), facing: /** @type {const} */ ('right') };
  const round = rounds.find((r) => t >= r.leave && t < r.back);
  if (round) return onRound(round, t);
  // by post-run the delivery is long over, whenever the page saw the run start. A run whose desk
  // the layout doesn't have isn't delivered.
  if (!run || run.postRun || !trip) return { ...home, carrying: null };
  const { route, walk, leave, arrive, back } = trip;
  if (t < leave) return { ...home, carrying: run.delivery.by === 'phone' && t >= run.delivery.at ? 'phone' : null };
  if (t >= back) return { ...home, carrying: null };
  const going = t < arrive;
  const f = going ? (t - leave) / walk : (t - arrive - HAND_MS) / walk;
  const p = alongRoute(going ? route : [...route].reverse(), f);
  return { who: 'carrier', ...p, pose: 'walking', carrying: t < arrive + HAND_MS ? run.delivery.by : null };
}

/**
 * A freeform run's worker's way from their seat at the desk they left round to their new seat.
 * Null when they haven't moved, or the layout lacks either desk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {WalkGraph} graph @param {NonNullable<Scene['run']>} run
 */
function moveRoute(layout, cubicles, graph, run) {
  if (!run.moved) return null;
  const out = roundDesk(layout, cubicles, graph, run.moved.from, seat);
  const into = roundDesk(layout, cubicles, graph, run.place, seat);
  return out && into ? deskToDesk(graph, out, into) : null;
}

/**
 * The active run's worker at `t`: not on the floor until the mail carrier arrives (in post-run
 * they have been at the desk all along, whenever the page saw the run start), then at their desk,
 * or carrying their papers over to a new one (a freeform run leaving the Freeform room for its
 * cubicle) once the carrier has handed the run over. `trip` is the carrier's own, worked out from
 * the layout at `t`, so the worker sits down the moment the carrier reaches the hand-over point,
 * even when the route changed mid-walk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Delivery | null} trip the run's delivery
 * @param {Move | null} move @param {Scene} scene @param {number} t
 * @returns {Worker | null}
 */
function worker(layout, cubicles, trip, move, scene, t) {
  const run = scene.run;
  if (!run || !trip) return null;
  if (t < trip.arrive && !run.postRun) return null;
  /** @param {Place} at @param {Rect} d @returns {Worker} */
  const seated = (at, d) => {
    const w = workerRect(d);
    return { who: 'worker', x: w.x, y: w.y, pose: 'seated', facing: 'right', pile: run.pile, at };
  };
  const desk = deskAt(layout, cubicles, run.place);
  // a worker who moved desks stays at the old one until the hand-over, even with no way over
  // (they stay put when the layout lacks the new desk)
  const from = run.moved && deskAt(layout, cubicles, run.moved.from);
  const handedOver = run.moved ? Math.max(run.moved.since, trip.arrive + HAND_MS) : -Infinity;
  if (run.moved && from && (t < handedOver || !desk)) return seated(run.moved.from, from);
  if (move && t < move.start + move.walk) {
    const p = alongRoute(move.route, (t - move.start) / move.walk);
    return { who: 'worker', x: p.x, y: p.y - WORKER_FEET, pose: 'walking', facing: p.facing, pile: run.pile, at: null };
  }
  return desk ? seated(run.place, desk) : null;
}

/**
 * The boss's last walk's route: from behind their chair or a worker's shoulder (`boss.from`) to the
 * other (`boss.at`), null when there's no walk to or from a worker. A desk the layout doesn't have
 * counts as the boss's own. `home`: behind their chair. `reading`: the walk ends at a worker's shoulder.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {WalkGraph} graph @param {Scene} scene
 */
function bossRoute(layout, cubicles, graph, scene) {
  // the Review room's desk is always in the layout, with room at both ends
  const home = /** @type {Point[]} */ (roundDesk(layout, cubicles, graph, { room: 'review' }, bossChair));
  /** @param {Place | null} p */
  const way = (p) => (p && roundDesk(layout, cubicles, graph, p, shoulder)) || null;
  const [from, at] = [way(scene.boss.from), way(scene.boss.at)];
  return { home: home[home.length - 1], route: from || at ? deskToDesk(graph, from ?? home, at ?? home) : null, reading: !!at };
}

/**
 * Every walk's route on `layout`: the delivery's, a worker's move and the boss's last walk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Scene} scene
 */
function routes(layout, cubicles, scene) {
  const graph = graphOf(layout, cubicles);
  const run = scene.run;
  return {
    delivery: run && deliveryRoute(layout, cubicles, graph, run),
    move: run && moveRoute(layout, cubicles, graph, run),
    boss: bossRoute(layout, cubicles, graph, scene),
  };
}

/**
 * The boss at `t`: at their desk, walking over to the worker, reading over their shoulder once
 * they're there, or walking back.
 * @param {BossWalk} walk @param {number} t
 * @returns {Boss}
 */
function boss({ route, since, walk, reading }, t) {
  const p = alongRoute(route, walk ? (t - since) / walk : 1);
  const pose = walk && t - since < walk ? 'walking' : reading ? 'standing' : 'seated';
  // seated, the boss sinks into their chair
  return { who: 'boss', x: p.x, y: p.y - BOSS_FEET + (pose === 'seated' ? 3 : 0), pose, facing: pose === 'seated' ? 'right' : p.facing };
}

/** How far below a walker's `y` their feet are: the carrier's `y` is their feet already. */
const FEET = { carrier: 0, boss: BOSS_FEET, worker: WORKER_FEET, stroller: WORKER_FEET, janitor: WORKER_FEET, helper: WORKER_FEET };

/** `route` without a point the same as the one before it. @param {Point[]} route */
const tidy = (route) => route.filter((p, i) => i === 0 || p.x !== route[i - 1].x || p.y !== route[i - 1].y);

/**
 * A resident's way from their seat to where their break goes: round their desk, over the walk
 * graph, and (to the water cooler or the bookshelf) across the room to the spot. Null when the
 * layout lacks their desk or the way.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {string} alias @param {import('./ambient.js').BreakTo} to
 * @returns {Point[] | null}
 */
function breakRoute(layout, cubicles, alias, to) {
  const graph = graphOf(layout, cubicles);
  const out = roundDesk(layout, cubicles, graph, { room: 'cubicle', alias }, seat);
  const there = graph.approaches.get(to.kind === 'chat' ? placeKey({ room: 'cubicle', alias: to.alias }) : to.kind === 'cooler' ? 'freeform' : 'joplin');
  if (!out || !there) return null;
  const spots = breakSpots(layout);
  const spot = to.kind === 'chat' ? there : to.kind === 'cooler' ? spots.cooler : spots.books;
  return tidy([...[...out].reverse(), ...shortestRoute(graph, out[0], there).slice(1), { x: spot.x, y: there.y }, spot]);
}

/**
 * A resident on their break at `t`: walking there, standing there (facing the cooler, the shelf or
 * whoever they're chatting to, all on their left), or walking back.
 * @param {import('./ambient.js').Break} b @param {Point[]} route @param {number} t
 * @returns {Stroller}
 */
function stroller(b, route, t) {
  const dt = t - b.start;
  const standing = dt >= b.walk && dt < b.walk + b.linger;
  const p = standing
    ? { ...route[route.length - 1], facing: /** @type {const} */ ('left') }
    : dt < b.walk
      ? alongRoute(route, dt / b.walk)
      : alongRoute([...route].reverse(), (dt - b.walk - b.linger) / b.walk);
  return { who: 'stroller', alias: b.alias, x: p.x, y: p.y - WORKER_FEET, pose: standing ? 'standing' : 'walking', facing: p.facing, to: b.to };
}

/**
 * The night janitor's round: from the corridor along each aisle to its far end and back, aisle
 * after aisle, then back to the first. Null when there are no aisles.
 * @param {Layout} layout
 * @returns {Point[] | null}
 */
function janitorRound(layout) {
  const c = layout.corridors[0];
  if (!c || !layout.aisles.length) return null;
  const lane = c.x + Math.floor((c.w - 9) / 2);
  const round = layout.aisles.flatMap((a) => {
    const y = a.y + a.h - 3;
    const far = Math.abs(lane - a.x) > Math.abs(lane - (a.x + a.w)) ? a.x + 4 : a.x + a.w - 14;
    return [{ x: lane, y }, { x: far, y }, { x: lane, y }];
  });
  return [...round, round[0]];
}

/**
 * The boss pacing behind their desk, to and fro either side of their chair, for PACE_MS every
 * PACE_EVERY_MS; else null (seated).
 * @param {Point} home behind their chair (feet) @param {number} t
 * @returns {Boss | null}
 */
function pacing(home, t) {
  const c = ((t % PACE_EVERY_MS) + PACE_EVERY_MS) % PACE_EVERY_MS;
  if (c >= PACE_MS) return null;
  const legs = [0, PACE_REACH, 0, -PACE_REACH, 0];
  const f = (c / PACE_MS) * 4;
  const i = Math.min(3, Math.floor(f));
  return { who: 'boss', x: home.x + lerp(legs[i], legs[i + 1], f - i), y: home.y - BOSS_FEET, pose: 'walking', facing: legs[i + 1] > legs[i] ? 'right' : 'left' };
}

/**
 * The pixel a walker stands on: the middle of their feet, the row above the route point they're at.
 * @param {Walker} w
 * @returns {Point}
 */
export const feet = (w) => ({ x: w.x + 4, y: w.y + FEET[w.who] - 1 });

/**
 * Whether `route` goes through the doorway `d`: one of its points in it, or a leg across it.
 * @param {Point[]} route @param {Rect} d
 */
function goesThrough(route, d) {
  return route.some((a, i) => {
    const b = route[i + 1] ?? a;
    const steps = Math.max(1, Math.ceil(distance(a, b)));
    for (let k = 0; k <= steps; k++) if (inside(d, Math.round(a.x + ((b.x - a.x) * k) / steps), Math.round(a.y + ((b.y - a.y) * k) / steps))) return true;
    return false;
  });
}

/**
 * How far each side room's Door is open: by how near its doorway the nearest walker on foot is
 * whose route goes through it (someone only going past, down the narrow lane, leaves it shut).
 * @param {Layout} layout @param {Array<{ walker: Walker | null, route: Point[] | null }>} onFoot each walker, and the route they're on
 * @returns {Doors}
 */
function doors(layout, onFoot) {
  /** @type {Doors} */
  const open = {};
  for (const id of SIDE_ROOMS) {
    const d = layout.doorways[id];
    if (!d) continue;
    let near = Infinity;
    for (const { walker: w, route } of onFoot) {
      if (w?.pose !== 'walking' || !route || !goesThrough(route, d)) continue;
      const { x, y } = feet(w);
      near = Math.min(near, Math.hypot(Math.max(d.x - x, 0, x - (d.x + d.w - 1)), Math.max(d.y - y, 0, y - (d.y + d.h - 1))));
    }
    open[id] = Math.max(0, Math.min(1, (DOOR_FAR - near) / (DOOR_FAR - DOOR_NEAR)));
  }
  return open;
}

/**
 * Everyone who walks the floor at `t` (the mail carrier, the boss, and the active run's worker
 * once they're on it), and whether anything on the floor moves, so the page knows to keep drawing
 * frames: a run (typing, the delivery), a walk, a Door that isn't shut, or a resting state that moves.
 * @param {Layout} layout
 * @param {Scene['cubicles']} cubicles the scene's, in the layout's order
 * @param {Scene} scene
 * @param {number} t now on the scene's clock
 * @param {{ ambient?: { tzOffsetMin: number } }} [o] `ambient`: bring the office to life (ambient.js),
 *   on the viewer's clock, `tzOffsetMin` minutes behind UTC
 * @returns {{
 *   carrier: Carrier, boss: Boss, worker: Worker | null, doors: Doors, animating: boolean,
 *   part: import('./ambient.js').DayPart, residents: Resident[], strollers: Stroller[], janitor: Janitor | null,
 *   undelivered: Map<string, Set<number>>, helpers: Helper[],
 * }} `worker`: null until the mail carrier arrives with the run, or with no run. `doors`: how far
 *   each side room's Door is open. `part`: the time of day ('day' without ambient life).
 *   `residents`: those seated at their desks, `strollers`: those out on a break, and `janitor`:
 *   the night janitor, all empty without ambient life. `undelivered`: the in-tray letters still in
 *   the carrier's bag, by cubicle (trayNow). `helpers`: the colleagues helping the
 *   active run with its subagents (residents only with ambient life on, else temps).
 */
export function walkers(layout, cubicles, scene, t, o = {}) {
  const here = routes(layout, cubicles, scene);
  const timed = routes(timingOffice(cubicles), cubicles, scene);
  /** How long a walk takes: as long as its route on the office walks are timed on (which has every route this layout has). @param {Point[] | null} there */
  const timedWalk = (there) => walkMs(/** @type {Point[]} */ (there));
  const run = scene.run;
  // a run whose desk the layout doesn't have isn't delivered
  const { trip, rounds } = carrierPlan(layout, cubicles, scene, here.delivery, here.delivery ? timedWalk(timed.delivery) : null);
  /** @type {Move | null} */
  const move =
    run?.moved && trip && here.move
      ? { from: run.moved.from, route: here.move, start: Math.max(run.moved.since, trip.arrive + HAND_MS), walk: timedWalk(timed.move) }
      : null;
  const { home, route, reading } = here.boss;
  // no walk to or from a worker: seated at home all along
  const bossTrip = route ? { route, since: scene.boss.since, walk: timedWalk(timed.boss.route), reading } : { route: [home], since: scene.boss.since, walk: 0, reading: false };
  const onFloor = { carrier: carrier(layout, trip, rounds, scene, t), boss: boss(bossTrip, t), worker: worker(layout, cubicles, trip, move, scene, t) };
  const round = rounds.find((r) => t >= r.leave && t < r.back);
  const part = o.ambient && !scene.dark ? dayPart(t, o.ambient.tzOffsetMin) : null;
  const present = part ? residentsIn(scene, part, !!onFloor.worker) : [];
  // the subagents' colleagues first: whoever's called over isn't at their desk or on a break
  const help = helpersOnFloor(layout, cubicles, scene, t, present);
  const life = part ? ambientLife(layout, cubicles, scene, t, part, present.filter((a) => !help.recruited.has(a)), onFloor.worker) : null;
  // with PRs parked, the boss paces when they'd otherwise sit
  const paced = life && scene.parked.length && onFloor.boss.pose === 'seated' ? pacing(home, t) : null;
  if (paced) onFloor.boss = paced;
  const doorsOpen = doors(layout, [
    { walker: onFloor.carrier, route: round?.route ?? trip?.route ?? null },
    { walker: onFloor.boss, route: bossTrip.route },
    { walker: onFloor.worker, route: move?.route ?? null },
    ...(life?.strollers ?? []),
    ...help.helpers,
  ]);
  const animating =
    !scene.dark &&
    (!!run ||
      rounds.some((r) => t < r.back) ||
      help.helpers.some((h) => h.walker.pose === 'walking') ||
      !!paced ||
      !!life?.residents.length ||
      !!life?.strollers.length ||
      !!life?.janitor ||
      (!!bossTrip.walk && t - bossTrip.since < bossTrip.walk) ||
      Object.values(doorsOpen).some((v) => v > 0) ||
      scene.outcomes.some((o) => ANIMATED_STATES.has(o.state) || (o.state === 'stamped' && t - o.endedAt < STAMP_MS + TRAY_MS)));
  return {
    ...onFloor,
    doors: doorsOpen,
    animating,
    part: life?.part ?? 'day',
    residents: life?.residents ?? [],
    strollers: (life?.strollers ?? []).map((x) => x.walker),
    janitor: life?.janitor ?? null,
    undelivered: undeliveredMail(rounds, t),
    helpers: help.helpers.map((h) => h.walker),
  };
}

/**
 * Who plays the subagent in each slot, nearest first: the residents of the other workspace
 * cubicles not on Do Not Disturb, by how far along the office they sit from the run's cubicle.
 * @param {Scene['cubicles']} cubicles @param {Place} place the run's desk
 */
function recruits(cubicles, place) {
  const here = place.room === 'cubicle' ? cubicles.findIndex((c) => c.alias === place.alias) : -1;
  return cubicles
    .map((c, i) => ({ c, d: here < 0 ? i : Math.abs(i - here) + (i < here ? 0 : 0.5) }))
    .filter(({ c }) => c.workspace && !c.doNotDisturb && !(place.room === 'cubicle' && c.alias === place.alias))
    .sort((a, b) => a.d - b.d)
    .map(({ c }) => c.alias);
}

/**
 * Where the subagent in `slot` stands at the run's desk: in front of it, either side of the
 * worker in turn, inside the room, facing them. Null past HELPER_SPOTS, or when the layout lacks the desk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {WalkGraph} graph @param {Place} place @param {number} slot
 * @returns {(Point & { facing: 'left' | 'right' }) | null}
 */
function helperSpot(layout, cubicles, graph, place, slot) {
  const desk = deskAt(layout, cubicles, place);
  const front = graph.approaches.get(placeKey(place));
  const area = place.room === 'cubicle' ? layout.cubicles[cubicles.findIndex((c) => c.alias === place.alias)] : layout.rooms[place.room].rect;
  if (slot >= HELPER_SPOTS.length || !desk || !front || !area) return null;
  const { dx, dy } = HELPER_SPOTS[slot];
  const x = Math.max(area.x + 2, Math.min(area.x + area.w - 12, front.x + dx));
  return { x, y: Math.min(area.y + area.h - 1, front.y + dy), facing: x > workerRect(desk).x ? 'left' : 'right' };
}

/**
 * A subagent's colleague's way to the run's desk: from their seat round their desk and over (a
 * resident), or in from the front desk (a temp), to their spot. Null when there's no way.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Place} place @param {number} slot @param {string | null} recruit
 * @returns {Point[] | null}
 */
function helperRoute(layout, cubicles, place, slot, recruit) {
  const graph = graphOf(layout, cubicles);
  const spot = helperSpot(layout, cubicles, graph, place, slot);
  const there = graph.approaches.get(placeKey(place));
  if (!spot || !there) return null;
  const out = recruit ? roundDesk(layout, cubicles, graph, { room: 'cubicle', alias: recruit }, seat) : [graph.front];
  if (!out) return null;
  return tidy([...[...out].reverse(), ...shortestRoute(graph, out[0], there).slice(1), { x: spot.x, y: there.y }, { x: spot.x, y: spot.y }]);
}

/**
 * The colleagues helping the active run at `t`, one per subagent (scene.helpers): each played by
 * the resident in their slot (recruits) if they're in, else a temp from the Queue room; walking
 * over when called, standing at the desk while it runs (facing the worker, with what it's doing),
 * and walking back once it's done. `recruited`: the residents away from their desks for it.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Scene} scene @param {number} t @param {string[]} present
 */
function helpersOnFloor(layout, cubicles, scene, t, present) {
  /** @type {Array<{ walker: Helper, route: Point[] }>} */
  const helpers = [];
  /** @type {Set<string>} */
  const recruited = new Set();
  const timing = timingOffice(cubicles);
  for (const h of scene.helpers) {
    const who = recruits(cubicles, h.place)[h.slot] ?? null;
    const recruit = who && present.includes(who) ? who : null;
    const route = helperRoute(layout, cubicles, h.place, h.slot, recruit);
    const timed = helperRoute(timing, cubicles, h.place, h.slot, recruit);
    if (!route || !timed) continue;
    const walk = walkMs(timed);
    const arrive = h.since + walk;
    const leave = h.until == null ? Infinity : Math.max(h.until, arrive);
    if (t < h.since || t >= leave + walk) continue;
    if (recruit) recruited.add(recruit);
    const spot = /** @type {Point & { facing: 'left' | 'right' }} */ (helperSpot(layout, cubicles, graphOf(layout, cubicles), h.place, h.slot));
    const standing = t >= arrive && t < leave;
    const p = standing ? spot : t < arrive ? alongRoute(route, (t - h.since) / walk) : alongRoute([...route].reverse(), (t - leave) / walk);
    helpers.push({
      walker: { who: 'helper', id: h.id, x: p.x, y: p.y - WORKER_FEET, pose: standing ? 'standing' : 'walking', facing: p.facing, recruit, slot: h.slot, description: h.description, activity: h.until == null ? h.activity : null, done: h.until != null },
      route,
    });
  }
  return { helpers, recruited };
}

/**
 * The office's ambient life at `t` (ambient.js): the time of day, the residents seated in their
 * poses, those out on a break (with their routes, for the Doors), and the janitor at night.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Scene} scene @param {number} t
 * @param {import('./ambient.js').DayPart} part @param {string[]} present the residents in and at
 *   their desks' disposal (not helping a subagent)
 * @param {Worker | null} runWorker the active run's worker, if on the floor
 */
function ambientLife(layout, cubicles, scene, t, part, present, runWorker) {
  const timing = timingOffice(cubicles);
  /** @type {Map<string, Point[] | null>} */
  const here = new Map();
  /** @param {string} alias @param {import('./ambient.js').BreakTo} to */
  const key = (alias, to) => `${alias}>${to.kind === 'chat' ? `chat:${to.alias}` : to.kind}`;
  const underway = breaks(scene, present, t, (alias, to) => {
    const there = breakRoute(timing, cubicles, alias, to);
    here.set(key(alias, to), breakRoute(layout, cubicles, alias, to));
    return there && here.get(key(alias, to)) ? walkMs(there) : null;
  });
  const strollers = underway.map((b) => {
    const route = /** @type {Point[]} */ (here.get(key(b.alias, b.to)));
    return { walker: stroller(b, route, t), route };
  });
  const away = new Set(underway.map((b) => b.alias));
  /** The residents being visited, by the visitor standing with them now. */
  const visited = new Set(strollers.flatMap(({ walker: w }) => (w.pose === 'standing' && w.to.kind === 'chat' ? [w.to.alias] : [])));
  const beside = neighbours(layout, cubicles);
  const runAt = runWorker?.pose === 'seated' && runWorker.at?.room === 'cubicle' && !runWorker.at.job ? runWorker.at.alias : null;
  /** @type {Resident[]} */
  const residents = present
    .filter((alias) => !away.has(alias))
    .map((alias) => {
      const c = /** @type {Scene['cubicles'][number]} */ (cubicles.find((x) => x.alias === alias));
      if (visited.has(alias)) return { alias, pose: /** @type {const} */ ('chat'), facing: /** @type {const} */ ('right') };
      return { alias, ...restingPose(c, scene, t, beside.get(alias) ?? { left: null, right: null }, runAt) };
    });
  const round = part === 'night' ? janitorRound(layout) : null;
  /** @type {Janitor | null} */
  let janitor = null;
  if (round) {
    const length = routeLength(round);
    const p = alongRoute(round, (((t / 1000) * MOP_SPEED) % length) / length);
    janitor = { who: 'janitor', x: p.x, y: p.y - WORKER_FEET, pose: 'walking', facing: p.facing };
  }
  return { part, residents, strollers, janitor };
}
