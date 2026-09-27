// Draws the office floor: a scene (scene.js) placed on a layout (layout.js) with the sprites
// (sprites.js), at the layout's internal resolution. The page scales the result up by a whole
// number. Not tested: the rules live in the reducer, and this only draws. Who walks the floor
// (the mail carrier, the boss, a worker moving desks) and where comes from walkers.js; typing and
// the ends of runs (the stamp coming down, the papers to the out tray) are tweened here from when
// the run ended, so the reducer only says what happens and when.
import { formatClock } from './format.js';
import { WALL, cartSlots, cubicleDesks, deskAt, deskOwners, folderSlots, inTrayRect, inTraySlots, placeRect, roomAt, stickyNote, workerRect } from './layout.js';
import { samePlace } from './scene.js';
import * as s from './sprites.js';
import { STAMP_MS, TRAY_MS, lerp, walkers } from './walkers.js';

/** @typedef {import('./sprites.js').Ctx} Ctx */
/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./walkers.js').Walker} Walker */

/** Animation frames: walking and typing, and the autofix's frantic scribbling. */
const FRAME_MS = 150;
const SCRIBBLE_MS = 60;
/** A quick stamp coming down (a full one takes STAMP_MS). */
const QUICK_STAMP_MS = 400;
/** The stamped sheets in the out tray. */
const TRAY_SHEETS = 6;
/** A tumbleweed rolls through a quiet room this often, taking this long. */
const TUMBLE_EVERY_MS = 9000;
const TUMBLE_MS = 3000;
/** Resting states in which drawOutcomes draws the worker at their desk (or sends them home). */
const WORKER_STATES = new Set(['injured', 'asleep', 'dizzy', 'shrug', 'home']);

/** @param {Ctx} ctx @param {Layout} layout */
function drawBoss(ctx, layout) {
  const r = layout.rooms.review.rect;
  const d = layout.desks.review;
  s.wallWindow(ctx, r.x + 12, r.y + 6, 36);
  s.bossDesk(ctx, d.x, d.y);
  s.plant(ctx, r.x + 6, r.y + WALL + 4);
  s.cabinets(ctx, r.x + r.w - 26, r.y + WALL + 2, 2);
}

/** @param {Ctx} ctx @param {Layout} layout */
function drawJoplinRoom(ctx, layout) {
  const r = layout.rooms.joplin.rect;
  s.bookshelf(ctx, r.x + 6, r.y + 3, Math.min(60, r.w - 70));
  s.bookshelf(ctx, r.x + 6, r.y + WALL + 4, 40);
  s.table(ctx, layout.desks.joplin.x, layout.desks.joplin.y);
  s.plant(ctx, r.x + r.w - 14, r.y + r.h - 16);
}

/** @param {Ctx} ctx @param {Layout} layout */
function drawFreeformRoom(ctx, layout) {
  const r = layout.rooms.freeform.rect;
  const d = layout.desks.freeform;
  s.wallWindow(ctx, r.x + 8, r.y + 6, 30);
  s.desk(ctx, d.x, d.y, d.w);
  s.cabinets(ctx, r.x + r.w - 36, r.y + WALL + 2, 3);
  s.waterCooler(ctx, r.x + 6, r.y + WALL + 4);
}

/**
 * The active run: the phone ringing, the worker at their desk (typing, still, or scribbling) with
 * their pile and speech bubble, or walking over to a new desk with the pile, and the mail carrier
 * out delivering it.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t @param {Walker[]} walking
 */
function drawRun(ctx, layout, scene, t, walking) {
  const run = scene.run;
  const desk = run && deskAt(layout, scene.cubicles, run.place);
  if (!run || !desk) return;
  const frame = Math.floor(t / FRAME_MS);
  for (const p of walking) {
    if (p.who === 'carrier' && p.pose === 'standing' && p.carrying === 'phone') s.phoneRinging(ctx, layout.desk, frame);
    if (p.who !== 'worker') continue;
    if (p.pose === 'walking') {
      s.walkingWorker(ctx, p.x, p.y, frame, p.pile);
      continue;
    }
    const w = workerRect(desk);
    const typing = run.work === 'typing';
    const scribbling = run.work === 'scribbling';
    const beat = scribbling ? Math.floor(t / SCRIBBLE_MS) : frame;
    s.worker(ctx, w, typing || scribbling ? /** @type {1 | 2} */ ((beat % 2) + 1) : 0);
    if (run.worker) s.jobGear(ctx, run.worker, w, desk, frame);
    if (scribbling) s.scribbles(ctx, w, beat);
    s.paperPile(ctx, desk.x + 2, desk.y + 3, p.pile);
    const bounds = roomAt(layout, run.place).rect;
    if (run.bubble) s.speechBubble(ctx, w.x + 5, w.y - 1, run.bubble, Math.min(120, bounds.w - 4), bounds);
  }
  for (const p of walking) if (p.who === 'carrier' && p.pose === 'walking') s.walkingCarrier(ctx, p.x, p.y, frame, p.carrying);
}

/** The scheduled job whose desk `place` is, by name. @param {import('./scene.js').Place} p */
const jobOf = (p) => (p.room === 'cubicle' ? p.job : undefined);

/**
 * The scheduled job whose desk `place` is, if any.
 * @param {Scene} scene @param {import('./scene.js').Place} place
 */
function jobAt(scene, place) {
  const job = jobOf(place);
  if (place.room !== 'cubicle' || !job) return null;
  const { alias } = place;
  return scene.cubicles.find((c) => c.alias === alias)?.jobs.find((j) => j.name === job) ?? null;
}

/**
 * Each scheduled job's worker at their desk while their job isn't running, unless their room's last
 * outcome has them (injured, asleep, dizzy, shrugging, or gone home). A running job's worker stays
 * put until the mail carrier arrives with it (drawRun takes over from then).
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {Walker[]} walking
 */
function drawJobWorkers(ctx, layout, scene, walking) {
  const run = scene.run;
  const arrived = run && walking.some((p) => p.who === 'worker');
  for (const c of scene.cubicles) {
    for (const j of c.jobs) {
      /** @type {import('./scene.js').Place} */
      const place = { room: 'cubicle', alias: c.alias, job: j.name };
      const desk = deskAt(layout, scene.cubicles, place);
      if (!desk) continue;
      if (arrived && samePlace(run.place, place) && jobOf(run.place) === j.name) continue;
      const o = scene.outcomes.find((x) => samePlace(x.place, place));
      if (o && WORKER_STATES.has(o.state) && (o.state === 'home' || jobOf(o.place) === j.name)) continue;
      const w = workerRect(desk);
      s.worker(ctx, w, 0);
      s.jobGear(ctx, j.worker, w, desk, null);
    }
  }
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
    const gear = jobAt(scene, o.place)?.worker;
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
        if (gear) s.jobGear(ctx, gear, w, desk, null);
        break;
      case 'asleep':
        s.sleepingWorker(ctx, w, desk.y);
        s.zzz(ctx, w.x + 9, desk.y - 12, Math.floor(t / 500));
        break;
      case 'dizzy': {
        const sway = { ...w, x: w.x + (Math.floor(t / 400) % 2) };
        s.worker(ctx, sway, 0);
        if (gear) s.jobGear(ctx, gear, sway, desk, null);
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
 * The folders on the boss's desk: the rooms with a PR left open, each labelled with its room, then
 * the PRs the cron has parked, each labelled with its issue.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene
 */
function drawFolders(ctx, layout, scene) {
  for (const f of folderSlots(layout, scene.cubicles, scene.outcomes, scene.parked)) s.folder(ctx, f.rect.x, f.rect.y, f.rect.w, f.tab, { parked: f.parked });
}

/**
 * A cubicle's pending issues: letters in its in-tray (a padlock on a blocked one; a slot holding
 * the overflow is a pile), and a sticky note while issues wait for a human.
 * @param {Ctx} ctx @param {Rect} r the cubicle @param {import('./scene.js').SceneCubicle} c
 */
function drawPending(ctx, r, c) {
  if (c.inTray.length) {
    s.inTray(ctx, inTrayRect(r));
    for (const slot of inTraySlots(r, c.inTray)) {
      s.letter(ctx, slot.rect, slot.letters.length);
      if (slot.letters.every((l) => l.blocked)) s.padlock(ctx, slot.rect);
    }
  }
  if (c.sticky.length) s.stickyNote(ctx, stickyNote(r), c.sticky.length);
}

/**
 * The boss: at their desk, walking over to the worker, reading over their shoulder, or walking back.
 * @param {Ctx} ctx @param {number} t @param {Walker[]} walking
 */
function drawBossFigure(ctx, t, walking) {
  for (const p of walking) {
    if (p.who !== 'boss') continue;
    if (p.pose === 'walking') s.boss(ctx, p.x, p.y, { step: Math.floor(t / FRAME_MS) });
    else if (p.pose === 'standing') s.boss(ctx, p.x, p.y);
    else s.boss(ctx, p.x, p.y, { seated: true });
  }
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
  const walking = walkers(layout, scene.cubicles, scene, t).walkers;
  ctx.clearRect(0, 0, layout.width, layout.height);
  s.room(ctx, rooms.review.rect, rooms.review.name, 'wood', WALL);
  s.room(ctx, rooms.joplin.rect, rooms.joplin.name, 'wood', WALL);
  s.room(ctx, rooms.freeform.rect, rooms.freeform.name, 'carpet', WALL);
  s.room(ctx, rooms.queueRoom.rect, rooms.queueRoom.name, 'tile', WALL);
  s.room(ctx, rooms.bullpen.rect, rooms.bullpen.name, 'carpet', WALL);
  drawBoss(ctx, layout);
  drawJoplinRoom(ctx, layout);
  drawFreeformRoom(ctx, layout);

  const b = rooms.bullpen.rect;
  s.wallWindow(ctx, b.x + 10, b.y + 6, 40);
  scene.cubicles.forEach((c, i) => {
    const r = layout.cubicles[i];
    if (!r) return;
    s.cubicle(ctx, r, cubicleDesks(r, deskOwners(c).length), c.name);
    drawPending(ctx, r, c);
    if (c.doNotDisturb) s.doNotDisturb(ctx, r);
    if (c.alias === filter) s.selected(ctx, r);
  });

  s.frontDoor(ctx, layout.door);
  if (scene.backInFive) s.backInFive(ctx, layout.door);
  if (scene.queueRoom.countdownMs != null) s.countdownClock(ctx, layout.clock, formatClock(scene.queueRoom.countdownMs));
  for (const p of walking) if (p.who === 'carrier' && p.pose === 'standing') s.mailCarrier(ctx, p.x, p.y);
  s.frontDesk(ctx, layout.desk);
  s.mailCart(ctx, layout.cart);
  for (const slot of cartSlots(layout, scene.queueRoom.letters)) s.letter(ctx, slot.rect, slot.pile);
  s.plant(ctx, rooms.queueRoom.rect.x + rooms.queueRoom.rect.w - 14, rooms.queueRoom.rect.y + WALL + 4);
  drawJobWorkers(ctx, layout, scene, walking);
  drawOutcomes(ctx, layout, scene, t);
  drawRun(ctx, layout, scene, t, walking);
  drawBossFigure(ctx, t, walking);
  drawFolders(ctx, layout, scene);

  if (scene.dark) {
    s.darkness(ctx, layout.width, layout.height);
    s.exitSign(ctx, layout.door);
  }
}
