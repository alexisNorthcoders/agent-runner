// Draws the office floor: a scene (scene.js) placed on a layout (layout.js) with the sprites
// (sprites.js), at the layout's internal resolution. The page scales the result up by a whole
// number. Not tested: the rules live in the reducer, and this only draws. The animations (the
// mail carrier's delivery, the boss's walks, typing) are tweened here from the times the scene
// gives, so the reducer only says what happens and when.
import { formatClock } from './format.js';
import { WALL, cartSlots, cubicleDesk, deskAt, roomAt, workerRect } from './layout.js';
import * as s from './sprites.js';

/** @typedef {import('./sprites.js').Ctx} Ctx */
/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./scene.js').Scene} Scene */

/** How long the phone rings before the mail carrier sets off, a walk takes, and the hand-over. */
const RING_MS = 1600;
const WALK_MS = 2400;
const HAND_MS = 500;
/** Animation frames: walking and typing, and the autofix's frantic scribbling. */
const FRAME_MS = 150;
const SCRIBBLE_MS = 60;

/** @param {Ctx} ctx @param {Layout} layout */
function drawBoss(ctx, layout) {
  const r = layout.rooms.boss.rect;
  const d = layout.desks.boss;
  s.wallWindow(ctx, r.x + 12, r.y + 6, 36);
  s.bossDesk(ctx, d.x, d.y);
  s.plant(ctx, r.x + 6, r.y + WALL + 4);
  s.cabinets(ctx, r.x + r.w - 26, r.y + WALL + 2, 2);
}

/** @param {Ctx} ctx @param {Layout} layout */
function drawLibrary(ctx, layout) {
  const r = layout.rooms.library.rect;
  s.bookshelf(ctx, r.x + 6, r.y + 3, Math.min(60, r.w - 70));
  s.bookshelf(ctx, r.x + 6, r.y + WALL + 4, 40);
  s.table(ctx, layout.desks.library.x, layout.desks.library.y);
  s.plant(ctx, r.x + r.w - 14, r.y + r.h - 16);
}

/** @param {Ctx} ctx @param {Layout} layout */
function drawAnnex(ctx, layout) {
  const r = layout.rooms.annex.rect;
  const d = layout.desks.annex;
  s.wallWindow(ctx, r.x + 8, r.y + 6, 30);
  s.desk(ctx, d.x, d.y, d.w);
  s.cabinets(ctx, r.x + r.w - 36, r.y + WALL + 2, 3);
  s.waterCooler(ctx, r.x + 6, r.y + WALL + 4);
}

/** @param {number} a @param {number} b @param {number} f 0..1 */
const lerp = (a, b, f) => Math.round(a + (b - a) * Math.max(0, Math.min(1, f)));

/** Where the mail carrier stands to set off, in front of the reception desk (feet). @param {Layout} layout */
const carrierStart = (layout) => ({ x: layout.desk.x + 30, y: layout.desk.y + layout.desk.h + 14 });
/** Where the carrier hands a run over, in front of the worker's desk (feet). @param {Rect} desk */
const handOver = (desk) => ({ x: desk.x + Math.floor(desk.w / 2) + 4, y: desk.y + desk.h + 16 });
/** The boss's head, standing behind their chair and by a worker's shoulder. @param {Layout} layout */
const bossHome = (layout) => ({ x: layout.desks.boss.x + 23, y: layout.desks.boss.y - 20 });
/** @param {Rect} desk */
const bossBeside = (desk) => {
  const w = workerRect(desk);
  return { x: w.x + 10, y: w.y - 3 };
};

/**
 * The run's timeline, from its delivery: when the mail carrier arrives with it (the worker is at
 * the desk from then on) and is back at Reception.
 * @param {NonNullable<Scene['run']>} run
 */
function deliveryTimes(run) {
  const leave = run.delivery.at + (run.delivery.by === 'phone' ? RING_MS : 0);
  return { leave, arrive: leave + WALK_MS, back: leave + 2 * WALK_MS + HAND_MS };
}

/**
 * Whether anything on the floor moves at time `t`, so the page knows to keep drawing frames.
 * @param {Scene} scene @param {number} t
 */
export const animating = (scene, t) => !scene.dark && (!!scene.run || t - scene.boss.since < WALK_MS);

/** Whether the mail carrier is out delivering at `t`, away from the reception desk. @param {Scene} scene @param {number} t */
function carrierOut(scene, t) {
  if (!scene.run) return false;
  const { leave, back } = deliveryTimes(scene.run);
  return t >= leave && t < back;
}

/**
 * The active run: the delivery, the worker at their desk (typing, still, or scribbling), their pile
 * and speech bubble.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t
 */
function drawRun(ctx, layout, scene, t) {
  const run = scene.run;
  const desk = run && deskAt(layout, scene.cubicles, run.place);
  if (!run || !desk) return;
  const { leave, arrive } = deliveryTimes(run);
  const frame = Math.floor(t / FRAME_MS);
  if (t < leave) s.phoneRinging(ctx, layout.desk, frame);
  if (t >= arrive) {
    const w = workerRect(desk);
    const typing = run.work === 'typing';
    const scribbling = run.work === 'scribbling';
    const beat = scribbling ? Math.floor(t / SCRIBBLE_MS) : frame;
    s.worker(ctx, w, typing || scribbling ? /** @type {1 | 2} */ ((beat % 2) + 1) : 0);
    if (scribbling) s.scribbles(ctx, w, beat);
    s.paperPile(ctx, desk.x + 2, desk.y + 3, run.pile);
    const bounds = roomAt(layout, run.place).rect;
    if (run.bubble) s.speechBubble(ctx, w.x + 5, w.y - 1, run.bubble, Math.min(120, bounds.w - 4), bounds);
  }
  if (!carrierOut(scene, t)) return;
  const from = carrierStart(layout);
  const to = handOver(desk);
  const going = t < arrive;
  const f = going ? (t - leave) / WALK_MS : (t - arrive - HAND_MS) / WALK_MS;
  const [a, b] = going ? [from, to] : [to, from];
  s.walkingCarrier(ctx, lerp(a.x, b.x, f), lerp(a.y, b.y, f), frame, t < arrive + HAND_MS ? run.delivery.by : null);
}

/**
 * The boss: at their desk, walking over to the worker, reading over their shoulder, or walking back.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t
 */
function drawBossFigure(ctx, layout, scene, t) {
  const { at, from, since } = scene.boss;
  const home = bossHome(layout);
  /** @param {import('./scene.js').Place | null} p */
  const spot = (p) => {
    const d = p && deskAt(layout, scene.cubicles, p);
    return d ? bossBeside(d) : home;
  };
  const f = (t - since) / WALK_MS;
  const step = Math.floor(t / FRAME_MS);
  if (f < 1) {
    const a = spot(from);
    const b = spot(at);
    s.boss(ctx, lerp(a.x, b.x, f), lerp(a.y, b.y, f), { step });
  } else if (at) {
    const b = spot(at);
    s.boss(ctx, b.x, b.y);
  } else s.boss(ctx, home.x, home.y + 3, { seated: true });
}

/**
 * @param {Ctx} ctx
 * @param {Layout} layout
 * @param {Scene} scene
 * @param {{ t: number, filter?: string | null }} o `t`: now on the scene's clock, for the
 *   animations. `filter`: the workspace the panel is filtered to, outlined.
 */
export function drawOffice(ctx, layout, scene, { t, filter = null }) {
  const { rooms } = layout;
  ctx.clearRect(0, 0, layout.width, layout.height);
  s.room(ctx, rooms.boss.rect, rooms.boss.name, 'wood', WALL);
  s.room(ctx, rooms.library.rect, rooms.library.name, 'wood', WALL);
  s.room(ctx, rooms.annex.rect, rooms.annex.name, 'carpet', WALL);
  s.room(ctx, rooms.reception.rect, rooms.reception.name, 'tile', WALL);
  s.room(ctx, rooms.bullpen.rect, rooms.bullpen.name, 'carpet', WALL);
  drawBoss(ctx, layout);
  drawLibrary(ctx, layout);
  drawAnnex(ctx, layout);

  const b = rooms.bullpen.rect;
  s.wallWindow(ctx, b.x + 10, b.y + 6, 40);
  scene.cubicles.forEach((c, i) => {
    const r = layout.cubicles[i];
    if (!r) return;
    s.cubicle(ctx, r, cubicleDesk(r), c.name);
    if (c.doNotDisturb) s.doNotDisturb(ctx, r);
    if (c.alias === filter) s.selected(ctx, r);
  });

  s.frontDoor(ctx, layout.door);
  if (scene.backInFive) s.backInFive(ctx, layout.door);
  if (scene.reception.countdownMs != null) s.countdownClock(ctx, layout.clock, formatClock(scene.reception.countdownMs));
  if (!carrierOut(scene, t)) s.mailCarrier(ctx, layout.desk.x + 30, layout.desk.y - 16);
  s.receptionDesk(ctx, layout.desk);
  s.mailCart(ctx, layout.cart);
  for (const slot of cartSlots(layout, scene.reception.letters)) s.letter(ctx, slot.rect, slot.pile);
  s.plant(ctx, rooms.reception.rect.x + rooms.reception.rect.w - 14, rooms.reception.rect.y + WALL + 4);
  drawRun(ctx, layout, scene, t);
  drawBossFigure(ctx, layout, scene, t);

  if (scene.dark) {
    s.darkness(ctx, layout.width, layout.height);
    s.exitSign(ctx, layout.door);
  }
}
