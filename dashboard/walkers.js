// Who walks the office floor at a given time, and where: the mail carrier's delivery, the boss's
// walks to a worker's shoulder and back, and a worker moving desks with their papers, all routed
// over the layout's walk graph at a steady pace from the times the scene gives. Also how far each
// side room's Door is open, from how near someone walking is, and whether anything on the floor
// still moves. No DOM here, so it can be tested in Node; officeView.js draws
// what it returns.
import { SIDE_ROOMS, WIDE_WIDTH, deskAt, deskOwners, inside, layoutOffice, placeKey, walkGraph, workerRect } from './layout.js';

/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./layout.js').Point} Point */
/** @typedef {import('./layout.js').WalkGraph} WalkGraph */
/** @typedef {import('./scene.js').Place} Place */
/** @typedef {import('./scene.js').Scene} Scene */

/**
 * @typedef {{ who: 'carrier', x: number, y: number, pose: 'walking' | 'standing', facing: 'left' | 'right', carrying: 'phone' | 'envelope' | null }} Carrier
 *   The mail carrier: standing behind the front desk (as the top of their cap, `carrying` the
 *   phone while it rings), or out delivering (as their feet, `carrying` the run until the
 *   hand-over), `facing` the way they're heading.
 * @typedef {{ who: 'boss', x: number, y: number, pose: 'walking' | 'standing' | 'seated', facing: 'left' | 'right' }} Boss
 *   The boss, as the top of their head: seated at their desk, walking, or standing at a worker's
 *   shoulder (reading), `facing` the way they're heading (or last headed).
 * @typedef {{ who: 'worker', x: number, y: number, pose: 'walking' | 'seated', facing: 'left' | 'right', pile: number, at: Place | null }} Worker
 *   The active run's worker, as the top of their head: seated at the desk of `at` once the mail
 *   carrier has arrived, or walking to a new desk with their `pile` of papers (`at` null), `facing`
 *   the way they're heading.
 * @typedef {Carrier | Boss | Worker} Walker
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

/**
 * The shortest way over the walk graph from `from` to `to`, as the points to walk through; straight
 * there if the graph doesn't join them.
 * @param {import('./layout.js').WalkGraph} graph @param {Point} from @param {Point} to
 * @returns {Point[]}
 */
function shortestRoute(graph, from, to) {
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
const timingOffice = (cubicles) => layoutOffice(cubicles.length, 'wide', WIDE_WIDTH.min);

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

/**
 * The run's delivery: the carrier's route on the current layout, and when they set off, arrive
 * with the run (the worker is at that desk from then on) and are back in the Queue room.
 * @param {Point[]} route @param {number} walk how long it takes, in ms @param {NonNullable<Scene['run']>} run
 */
function delivery(route, walk, run) {
  const leave = run.delivery.at + (run.delivery.by === 'phone' ? RING_MS : 0);
  return { route, walk, leave, arrive: leave + walk, back: leave + 2 * walk + HAND_MS };
}

/**
 * @typedef {ReturnType<typeof delivery>} Delivery
 * @typedef {{ from: Place, route: Point[], start: number, walk: number }} Move
 *   A freeform run's worker moving desks: their route, and when they set off (once the mail carrier
 *   has handed the run over at the old desk) and how long it takes.
 * @typedef {{ route: Point[], since: number, walk: number, reading: boolean }} BossWalk
 *   The boss's last walk: its route, setting off at `boss.since`, and how long it takes.
 */

/**
 * The mail carrier at `t`: out delivering the active run, else behind the front desk.
 * @param {Layout} layout @param {Delivery | null} trip the run's delivery, if the layout has its desk
 * @param {Scene} scene @param {number} t
 * @returns {Carrier}
 */
function carrier(layout, trip, scene, t) {
  const run = scene.run;
  const home = { who: /** @type {const} */ ('carrier'), ...carrierHome(layout), pose: /** @type {const} */ ('standing'), facing: /** @type {const} */ ('right') };
  // by post-run the delivery is long over, whenever the page saw the run start. A run whose desk
  // the layout doesn't have isn't delivered.
  if (!run || run.postRun || !trip) return { ...home, carrying: null };
  const { route, walk, leave, arrive, back } = trip;
  if (t < leave) return { ...home, carrying: 'phone' };
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
  const graph = walkGraph(layout, cubicles);
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
const FEET = { carrier: 0, boss: BOSS_FEET, worker: WORKER_FEET };

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
 * @returns {{ carrier: Carrier, boss: Boss, worker: Worker | null, doors: Doors, animating: boolean }} `worker`:
 *   null until the mail carrier arrives with the run, or with no run. `doors`: how far each side
 *   room's Door is open.
 */
export function walkers(layout, cubicles, scene, t) {
  const here = routes(layout, cubicles, scene);
  const timed = routes(timingOffice(cubicles), cubicles, scene);
  /** How long a walk takes: as long as its route on the office walks are timed on (which has every route this layout has). @param {Point[] | null} there */
  const timedWalk = (there) => walkMs(/** @type {Point[]} */ (there));
  const run = scene.run;
  // a run whose desk the layout doesn't have isn't delivered
  const trip = run && here.delivery ? delivery(here.delivery, timedWalk(timed.delivery), run) : null;
  /** @type {Move | null} */
  const move =
    run?.moved && trip && here.move
      ? { from: run.moved.from, route: here.move, start: Math.max(run.moved.since, trip.arrive + HAND_MS), walk: timedWalk(timed.move) }
      : null;
  const { home, route, reading } = here.boss;
  // no walk to or from a worker: seated at home all along
  const bossTrip = route ? { route, since: scene.boss.since, walk: timedWalk(timed.boss.route), reading } : { route: [home], since: scene.boss.since, walk: 0, reading: false };
  const onFloor = { carrier: carrier(layout, trip, scene, t), boss: boss(bossTrip, t), worker: worker(layout, cubicles, trip, move, scene, t) };
  const doorsOpen = doors(layout, [
    { walker: onFloor.carrier, route: trip?.route ?? null },
    { walker: onFloor.boss, route: bossTrip.route },
    { walker: onFloor.worker, route: move?.route ?? null },
  ]);
  const animating =
    !scene.dark &&
    (!!run ||
      (!!bossTrip.walk && t - bossTrip.since < bossTrip.walk) ||
      Object.values(doorsOpen).some((v) => v > 0) ||
      scene.outcomes.some((o) => ANIMATED_STATES.has(o.state) || (o.state === 'stamped' && t - o.endedAt < STAMP_MS + TRAY_MS)));
  return { ...onFloor, doors: doorsOpen, animating };
}
