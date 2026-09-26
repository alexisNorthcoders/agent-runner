// Draws the office floor: a scene (scene.js) placed on a layout (layout.js) with the sprites
// (sprites.js), at the layout's internal resolution. The page scales the result up by a whole
// number. Not tested: the rules live in the reducer, and this only draws. The animations (the
// mail carrier's delivery, the boss's walks, typing) are tweened here from the times the scene
// gives, so the reducer only says what happens and when, as are the ends of runs (the stamp coming
// down, the papers to the out tray) from when the run ended.
import { formatClock } from './format.js';
import { WALL, cartSlots, cubicleDesk, deskAt, placeName, placeRect, roomAt, workerRect } from './layout.js';
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
/** A finished run's stamp coming down, and its papers going to the out tray (a quick stamp is shorter). */
const STAMP_MS = 900;
const QUICK_STAMP_MS = 400;
const TRAY_MS = 900;
/** The stamped sheets in the out tray. */
const TRAY_SHEETS = 6;
/** A tumbleweed rolls through a quiet room this often, taking this long. */
const TUMBLE_EVERY_MS = 9000;
const TUMBLE_MS = 3000;
/** Resting states that keep moving: Zzz, stars, the tumbleweed. */
const ANIMATED_STATES = new Set(['asleep', 'dizzy', 'shrug']);
/** The most folders the boss's desk holds. */
const FOLDERS_MAX = 4;

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
export const animating = (scene, t) =>
  !scene.dark &&
  (!!scene.run || t - scene.boss.since < WALK_MS || scene.outcomes.some((o) => ANIMATED_STATES.has(o.state) || (o.state === 'stamped' && t - o.endedAt < STAMP_MS + TRAY_MS)));

/** Whether the mail carrier is out delivering at `t`, away from the reception desk. @param {Scene} scene @param {number} t */
function carrierOut(scene, t) {
  // by post-run the delivery is long over, whenever the page saw the run start
  if (!scene.run || scene.run.postRun) return false;
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
  if (t < leave && !run.postRun) s.phoneRinging(ctx, layout.desk, frame);
  // in post-run the worker has been at the desk all along, whenever the page saw the run start
  if (t >= arrive || run.postRun) {
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
 * How each room's last run left it, until its next run: the stamp and the out tray, the injured,
 * sleeping, dizzy or shrugging worker, the tumbleweed, or a dark, empty room where the worker went home.
 * A PR left open is a folder on the boss's desk instead (drawFolders).
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t
 */
function drawOutcomes(ctx, layout, scene, t) {
  for (const o of scene.outcomes) {
    const desk = deskAt(layout, scene.cubicles, o.place);
    const area = placeRect(layout, scene.cubicles, o.place);
    if (!desk || !area) continue;
    const w = workerRect(desk);
    const since = t - o.endedAt;
    switch (o.state) {
      case 'stamped': {
        const sheet = { x: desk.x + 2, y: desk.y + 1 };
        const tray = { x: desk.x + desk.w - 11, y: desk.y + 3 };
        if (o.quick) {
          s.stampedSheet(ctx, sheet.x, sheet.y);
          if (since < QUICK_STAMP_MS) s.stamp(ctx, sheet.x, sheet.y + 1, lerp(6, 0, since / QUICK_STAMP_MS), false);
        } else if (since < STAMP_MS) {
          s.paperPile(ctx, sheet.x, sheet.y + 2, TRAY_SHEETS);
          s.stamp(ctx, sheet.x - 1, sheet.y + 2 - TRAY_SHEETS, lerp(14, 0, since / STAMP_MS), true);
        } else if (since < STAMP_MS + TRAY_MS) {
          // the sheets slide over to the tray one by one
          const f = (since - STAMP_MS) / TRAY_MS;
          const moved = Math.min(TRAY_SHEETS, Math.floor(f * (TRAY_SHEETS + 1)));
          s.paperPile(ctx, sheet.x, sheet.y + 2, TRAY_SHEETS - moved);
          s.outTray(ctx, tray.x, tray.y, moved);
        } else s.outTray(ctx, tray.x, tray.y, TRAY_SHEETS);
        break;
      }
      case 'injured':
        s.worker(ctx, w, 0);
        s.bandage(ctx, w);
        break;
      case 'asleep':
        s.sleepingWorker(ctx, w, desk.y);
        s.zzz(ctx, w.x + 9, desk.y - 12, Math.floor(t / 500));
        break;
      case 'dizzy': {
        const sway = { ...w, x: w.x + (Math.floor(t / 400) % 2) };
        s.worker(ctx, sway, 0);
        s.flushed(ctx, sway);
        s.dizzyStars(ctx, sway.x + 1, sway.y - 4, Math.floor(t / 200));
        break;
      }
      case 'shrug': {
        s.shruggingWorker(ctx, w);
        const roll = since % TUMBLE_EVERY_MS;
        if (roll >= 0 && roll < TUMBLE_MS) {
          const floorY = area.y + area.h - 3;
          s.tumbleweed(ctx, lerp(area.x + 4, area.x + area.w - 11, roll / TUMBLE_MS), floorY, Math.floor(t / 120));
        }
        break;
      }
      case 'home':
        s.roomDark(ctx, area);
        break;
    }
  }
}

/**
 * The folders the rooms with a PR left open put on the boss's desk, each labelled with its room.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene
 */
function drawFolders(ctx, layout, scene) {
  const d = layout.desks.boss;
  const open = scene.outcomes.filter((o) => o.state === 'folder').slice(0, FOLDERS_MAX);
  open.forEach((o, i) => {
    s.folder(ctx, d.x + (i % 2) * 29, d.y - 1 - Math.floor(i / 2) * 9, 27, placeName(layout, scene.cubicles, o.place));
  });
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
  drawOutcomes(ctx, layout, scene, t);
  drawRun(ctx, layout, scene, t);
  drawBossFigure(ctx, layout, scene, t);
  drawFolders(ctx, layout, scene);

  if (scene.dark) {
    s.darkness(ctx, layout.width, layout.height);
    s.exitSign(ctx, layout.door);
  }
}
