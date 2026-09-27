// Who walks the office floor at a given time, and where: the mail carrier's delivery (routed over
// the layout's walk graph, at a steady pace), the boss's walks to a worker's shoulder and back, and
// a worker moving desks with their papers, tweened from the times the scene gives. Also whether
// anything on the floor still moves. No DOM here, so it can be tested in Node; officeView.js draws
// what it returns.
import { deskAt, placeKey, walkGraph, workerRect } from './layout.js';

/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./layout.js').Point} Point */
/** @typedef {import('./scene.js').Scene} Scene */

/**
 * @typedef {{ who: 'carrier', x: number, y: number, pose: 'walking' | 'standing', facing: 'left' | 'right', carrying: 'phone' | 'envelope' | null }} Carrier
 *   The mail carrier: standing behind the front desk (as the top of their cap, `carrying` the
 *   phone while it rings), or out delivering (as their feet, `carrying` the run until the
 *   hand-over), `facing` the way they're heading.
 * @typedef {{ who: 'boss', x: number, y: number, pose: 'walking' | 'standing' | 'seated' }} Boss
 *   The boss, as the top of their head: seated at their desk, walking, or standing at a worker's shoulder.
 * @typedef {{ who: 'worker', x: number, y: number, pose: 'walking' | 'seated', pile: number }} Worker
 *   The active run's worker, as the top of their head: seated at their desk once the mail carrier
 *   has arrived, or walking to a new desk with their `pile` of papers.
 * @typedef {Carrier | Boss | Worker} Walker
 */

/** How long the phone rings before the mail carrier sets off, and the hand-over. */
export const RING_MS = 1600;
export const HAND_MS = 500;
/** The mail carrier's pace, in scene pixels a second. */
export const WALK_SPEED = 60;
/** How long the boss's walks, and a worker's move to a new desk, take. */
export const WALK_MS = 2400;
/** A finished run's stamp coming down, and its papers going to the out tray. */
export const STAMP_MS = 900;
export const TRAY_MS = 900;
/** Resting states that keep moving: Zzz, stars, the tumbleweed. */
const ANIMATED_STATES = new Set(['asleep', 'dizzy', 'shrug']);

/** @param {number} a @param {number} b @param {number} f 0..1 */
export const lerp = (a, b, f) => Math.round(a + (b - a) * Math.max(0, Math.min(1, f)));

/** Where the mail carrier stands behind the front desk (top of their cap). @param {Layout} layout */
const carrierHome = (layout) => ({ x: layout.desk.x + 30, y: layout.desk.y - 16 });
/** The boss's head, standing behind their chair and by a worker's shoulder. @param {Layout} layout */
const bossHome = (layout) => ({ x: layout.desks.review.x + 23, y: layout.desks.review.y - 20 });
/** @param {Rect} desk */
const bossBeside = (desk) => {
  const w = workerRect(desk);
  return { x: w.x + 10, y: w.y - 3 };
};

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

/**
 * The run's delivery, from the current layout: the carrier's route from the front desk to the
 * desk's approach point, and when they set off, arrive with the run (the worker is at the desk
 * from then on) and are back in the Queue room. A walk takes as long as its route at WALK_SPEED.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {NonNullable<Scene['run']>} run
 */
function delivery(layout, cubicles, run) {
  const graph = walkGraph(layout, cubicles);
  const to = graph.approaches.get(placeKey(run.place));
  const route = to ? shortestRoute(graph, graph.front, to) : [graph.front];
  const walk = (routeLength(route) / WALK_SPEED) * 1000;
  const leave = run.delivery.at + (run.delivery.by === 'phone' ? RING_MS : 0);
  return { route, walk, leave, arrive: leave + walk, back: leave + 2 * walk + HAND_MS };
}

/** @typedef {ReturnType<typeof delivery>} Delivery */

/**
 * The mail carrier at `t`: out delivering the active run, else behind the front desk.
 * @param {Layout} layout @param {Rect | null} desk the run's desk @param {Delivery | null} trip the run's delivery
 * @param {Scene} scene @param {number} t
 * @returns {Carrier}
 */
function carrier(layout, desk, trip, scene, t) {
  const run = scene.run;
  const home = { who: /** @type {const} */ ('carrier'), ...carrierHome(layout), pose: /** @type {const} */ ('standing'), facing: /** @type {const} */ ('right') };
  // by post-run the delivery is long over, whenever the page saw the run start. A run whose desk
  // the layout doesn't have isn't delivered.
  if (!run || run.postRun || !desk || !trip) return { ...home, carrying: null };
  const { route, walk, leave, arrive, back } = trip;
  if (t < leave) return { ...home, carrying: 'phone' };
  if (t >= back) return { ...home, carrying: null };
  const going = t < arrive;
  const f = going ? (t - leave) / walk : (t - arrive - HAND_MS) / walk;
  const p = alongRoute(going ? route : [...route].reverse(), f);
  return { who: 'carrier', ...p, pose: 'walking', carrying: t < arrive + HAND_MS ? run.delivery.by : null };
}

/**
 * The active run's worker at `t`: not on the floor until the mail carrier arrives (in post-run
 * they have been at the desk all along, whenever the page saw the run start), then at their desk,
 * or walking their papers over to a new desk (a freeform run leaving the Freeform room for its
 * cubicle) once the carrier has handed the run over. `trip` is the carrier's own, worked out from
 * the layout at `t`, so the worker sits down the moment the carrier reaches the hand-over point,
 * even when the route changed mid-walk.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Rect | null} desk the run's desk
 * @param {Delivery | null} trip the run's delivery @param {Scene} scene @param {number} t
 * @returns {Worker | null}
 */
function worker(layout, cubicles, desk, trip, scene, t) {
  const run = scene.run;
  if (!run || !desk || !trip) return null;
  const { arrive } = trip;
  if (run.moved) {
    const start = Math.max(run.moved.since, arrive);
    const f = (t - start) / WALK_MS;
    const from = deskAt(layout, cubicles, run.moved.from);
    if (f >= 0 && f < 1 && from) {
      const a = workerRect(from);
      const b = workerRect(desk);
      return { who: 'worker', x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), pose: 'walking', pile: run.pile };
    }
  }
  if (t < arrive && !run.postRun) return null;
  const w = workerRect(desk);
  return { who: 'worker', x: w.x, y: w.y, pose: 'seated', pile: run.pile };
}

/**
 * The boss at `t`: at their desk, walking over to the worker, reading over their shoulder, or walking back.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Scene} scene @param {number} t
 * @returns {Boss}
 */
function boss(layout, cubicles, scene, t) {
  const { at, from, since } = scene.boss;
  const home = bossHome(layout);
  /** @param {import('./scene.js').Place | null} p */
  const spot = (p) => {
    const d = p && deskAt(layout, cubicles, p);
    return d ? bossBeside(d) : home;
  };
  const f = (t - since) / WALK_MS;
  if (f < 1) {
    const a = spot(from);
    const b = spot(at);
    return { who: 'boss', x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), pose: 'walking' };
  }
  if (at) return { who: 'boss', ...spot(at), pose: 'standing' };
  return { who: 'boss', x: home.x, y: home.y + 3, pose: 'seated' };
}

/**
 * Everyone who walks the floor at `t` (the mail carrier, the boss, and the active run's worker
 * once they're on it), and whether anything on the floor moves, so the page knows to keep drawing
 * frames: a run (typing, the delivery), a walk, or a resting state that moves.
 * @param {Layout} layout
 * @param {Scene['cubicles']} cubicles the scene's, in the layout's order
 * @param {Scene} scene
 * @param {number} t now on the scene's clock
 * @returns {{ carrier: Carrier, boss: Boss, worker: Worker | null, animating: boolean }} `worker`:
 *   null until the mail carrier arrives with the run, or with no run.
 */
export function walkers(layout, cubicles, scene, t) {
  const desk = scene.run && deskAt(layout, cubicles, scene.run.place);
  const trip = scene.run && delivery(layout, cubicles, scene.run);
  const animating =
    !scene.dark &&
    (!!scene.run || t - scene.boss.since < WALK_MS || scene.outcomes.some((o) => ANIMATED_STATES.has(o.state) || (o.state === 'stamped' && t - o.endedAt < STAMP_MS + TRAY_MS)));
  return { carrier: carrier(layout, desk, trip, scene, t), boss: boss(layout, cubicles, scene, t), worker: worker(layout, cubicles, desk, trip, scene, t), animating };
}
