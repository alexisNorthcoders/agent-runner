// Who walks the office floor at a given time, and where: the mail carrier's delivery, the boss's
// walks to a worker's shoulder and back, and a worker moving desks with their papers, tweened from
// the times the scene gives. Also whether anything on the floor still moves. No DOM here, so it
// can be tested in Node; officeView.js draws what it returns.
import { deskAt, workerRect } from './layout.js';

/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./scene.js').Scene} Scene */

/**
 * @typedef {{ who: 'carrier', x: number, y: number, pose: 'walking' | 'standing', carrying: 'phone' | 'envelope' | null }} Carrier
 *   The mail carrier: standing behind the front desk (as the top of their cap, `carrying` the
 *   phone while it rings), or out delivering (as their feet, `carrying` the run until the hand-over).
 * @typedef {{ who: 'boss', x: number, y: number, pose: 'walking' | 'standing' | 'seated' }} Boss
 *   The boss, as the top of their head: seated at their desk, walking, or standing at a worker's shoulder.
 * @typedef {{ who: 'worker', x: number, y: number, pose: 'walking' | 'seated', pile: number }} Worker
 *   The active run's worker, as the top of their head: seated at their desk once the mail carrier
 *   has arrived, or walking to a new desk with their `pile` of papers.
 * @typedef {Carrier | Boss | Worker} Walker
 */

/** How long the phone rings before the mail carrier sets off, a walk takes, and the hand-over. */
export const RING_MS = 1600;
export const WALK_MS = 2400;
export const HAND_MS = 500;
/** A finished run's stamp coming down, and its papers going to the out tray. */
export const STAMP_MS = 900;
export const TRAY_MS = 900;
/** Resting states that keep moving: Zzz, stars, the tumbleweed. */
const ANIMATED_STATES = new Set(['asleep', 'dizzy', 'shrug']);

/** @param {number} a @param {number} b @param {number} f 0..1 */
export const lerp = (a, b, f) => Math.round(a + (b - a) * Math.max(0, Math.min(1, f)));

/** Where the mail carrier stands to set off, in front of the front desk (feet). @param {Layout} layout */
const carrierStart = (layout) => ({ x: layout.desk.x + 30, y: layout.desk.y + layout.desk.h + 14 });
/** Where the carrier hands a run over, in front of the worker's desk (feet). @param {Rect} desk */
const handOver = (desk) => ({ x: desk.x + Math.floor(desk.w / 2) + 4, y: desk.y + desk.h + 16 });
/** The boss's head, standing behind their chair and by a worker's shoulder. @param {Layout} layout */
const bossHome = (layout) => ({ x: layout.desks.review.x + 23, y: layout.desks.review.y - 20 });
/** @param {Rect} desk */
const bossBeside = (desk) => {
  const w = workerRect(desk);
  return { x: w.x + 10, y: w.y - 3 };
};

/**
 * The run's timeline, from its delivery: when the mail carrier sets off, arrives with it (the
 * worker is at the desk from then on) and is back in the Queue room.
 * @param {NonNullable<Scene['run']>} run
 */
function deliveryTimes(run) {
  const leave = run.delivery.at + (run.delivery.by === 'phone' ? RING_MS : 0);
  return { leave, arrive: leave + WALK_MS, back: leave + 2 * WALK_MS + HAND_MS };
}

/**
 * The mail carrier at `t`: out delivering the active run, else behind the front desk.
 * @param {Layout} layout @param {Rect | null} desk the run's desk @param {Scene} scene @param {number} t
 * @returns {Carrier}
 */
function carrier(layout, desk, scene, t) {
  const run = scene.run;
  const home = { who: /** @type {const} */ ('carrier'), x: layout.desk.x + 30, y: layout.desk.y - 16, pose: /** @type {const} */ ('standing') };
  // by post-run the delivery is long over, whenever the page saw the run start
  if (!run || run.postRun || !desk) return { ...home, carrying: null };
  const { leave, arrive, back } = deliveryTimes(run);
  if (t < leave) return { ...home, carrying: 'phone' };
  if (t >= back) return { ...home, carrying: null };
  const from = carrierStart(layout);
  const to = handOver(desk);
  const going = t < arrive;
  const f = going ? (t - leave) / WALK_MS : (t - arrive - HAND_MS) / WALK_MS;
  const [a, b] = going ? [from, to] : [to, from];
  return { who: 'carrier', x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), pose: 'walking', carrying: t < arrive + HAND_MS ? run.delivery.by : null };
}

/**
 * The active run's worker at `t`: not on the floor until the mail carrier arrives (in post-run
 * they have been at the desk all along, whenever the page saw the run start), then at their desk,
 * or walking their papers over to a new desk (a freeform run leaving the Freeform room for its
 * cubicle) once the carrier has handed the run over.
 * @param {Layout} layout @param {Scene['cubicles']} cubicles @param {Rect | null} desk the run's desk
 * @param {Scene} scene @param {number} t
 * @returns {Worker | null}
 */
function worker(layout, cubicles, desk, scene, t) {
  const run = scene.run;
  if (!run || !desk) return null;
  const { arrive } = deliveryTimes(run);
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
 * @returns {{ walkers: Walker[], animating: boolean }}
 */
export function walkers(layout, cubicles, scene, t) {
  const desk = scene.run && deskAt(layout, cubicles, scene.run.place);
  const w = worker(layout, cubicles, desk, scene, t);
  const animating =
    !scene.dark &&
    (!!scene.run || t - scene.boss.since < WALK_MS || scene.outcomes.some((o) => ANIMATED_STATES.has(o.state) || (o.state === 'stamped' && t - o.endedAt < STAMP_MS + TRAY_MS)));
  return { walkers: [carrier(layout, desk, scene, t), boss(layout, cubicles, scene, t), ...(w ? [w] : [])], animating };
}
