// Draws the office floor: a scene (scene.js) placed on a layout (layout.js) with the sprites
// (sprites.js), at the layout's internal resolution. The page scales the result up by a whole
// number. Not tested: the rules live in the reducer, and this only draws. Who walks the floor
// (the mail carrier, the boss, a worker moving desks) and where, and how far each Door is open,
// comes from walkers.js; typing and the ends of runs (the stamp coming down, the papers to the out
// tray) are tweened here from when the run ended, so the reducer only says what happens and when.
import { formatClock } from './format.js';
import { SIDE_ROOMS, WALL, backWallDoorway, breakSpots, cartSlots, cubicleDesks, deskAt, deskOwners, folderSlots, inTrayRect, inTraySlots, placeRect, roomAt, stickyNote, workerRect } from './layout.js';
import { WORKER_STATES } from './ambient.js';
import { PLAIN, TEMPS, lookKey, looksFor, workerKeys } from './looks.js';
import { samePlace } from './scene.js';
import * as s from './sprites.js';
import { STAMP_MS, TRAY_MS, lerp, trayNow, walkers } from './walkers.js';

/** @typedef {import('./sprites.js').Ctx} Ctx */
/** @typedef {import('./layout.js').Rect} Rect */
/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {ReturnType<typeof walkers>} Walkers */

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

/**
 * Where a side room's back wall and the floor under it end on the right: at its doorway when that's
 * in the back wall (narrow), else at the room's edge.
 * @param {Layout} layout @param {import('./layout.js').SideRoomId} id
 */
function clearRight(layout, id) {
  const r = layout.rooms[id].rect;
  return backWallDoorway(layout, id)?.x ?? r.x + r.w;
}

/** @param {Ctx} ctx @param {Layout} layout @param {import('./ambient.js').DayPart} part */
function drawBoss(ctx, layout, part) {
  const r = layout.rooms.review.rect;
  const d = layout.desks.review;
  s.wallWindow(ctx, r.x + 12, r.y + 6, 36, part);
  s.bossDesk(ctx, d.x, d.y);
  s.plant(ctx, r.x + 6, r.y + WALL + 4);
  s.cabinets(ctx, clearRight(layout, 'review') - 26, r.y + WALL + 2, 2);
}

/** @param {Ctx} ctx @param {Layout} layout */
function drawJoplinRoom(ctx, layout) {
  const r = layout.rooms.joplin.rect;
  s.bookshelf(ctx, r.x + 6, r.y + 3, Math.min(60, r.w - 70));
  s.bookshelf(ctx, r.x + 6, r.y + WALL + 4, 40);
  s.table(ctx, layout.desks.joplin.x, layout.desks.joplin.y);
  // front left, clear of the doorway
  s.plant(ctx, r.x + 6, r.y + r.h - 16);
}

/** @param {Ctx} ctx @param {Layout} layout @param {import('./ambient.js').DayPart} part */
function drawFreeformRoom(ctx, layout, part) {
  const r = layout.rooms.freeform.rect;
  const d = layout.desks.freeform;
  s.wallWindow(ctx, r.x + 8, r.y + 6, 30, part);
  s.desk(ctx, d.x, d.y, d.w);
  s.cabinets(ctx, clearRight(layout, 'freeform') - 36, r.y + WALL + 2, 3);
  const cooler = breakSpots(layout).waterCooler;
  s.waterCooler(ctx, cooler.x, cooler.y);
}

/**
 * The active run: the phone ringing, the worker at their desk (typing, still, or scribbling) with
 * their pile and speech bubble, or walking over to a new desk with the pile, and the mail carrier
 * out delivering it.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t @param {Walkers} walking
 */
function drawRun(ctx, layout, scene, t, { carrier, worker: p }) {
  const run = scene.run;
  if (!run) return;
  const frame = Math.floor(t / FRAME_MS);
  // whoever works the run's room, all along (a freeform run moving to a cubicle is its resident)
  const look = lookAt(scene, run.place);
  if (carrier.pose === 'standing' && carrier.carrying === 'phone') s.phoneRinging(ctx, layout.desk, frame);
  if (p?.pose === 'walking') s.walkingWorker(ctx, p.x, p.y, frame, p.pile, p.facing, look);
  // seated at the desk they're at: a freeform worker's old one until they move
  const desk = p?.at && deskAt(layout, scene.cubicles, p.at);
  if (p?.at && desk) {
    const w = workerRect(desk);
    const typing = run.work === 'typing';
    const scribbling = run.work === 'scribbling';
    const beat = scribbling ? Math.floor(t / SCRIBBLE_MS) : frame;
    s.worker(ctx, w, typing || scribbling ? /** @type {1 | 2} */ ((beat % 2) + 1) : 0, look);
    if (run.worker) s.jobGear(ctx, run.worker, w, desk, frame);
    if (scribbling) s.scribbles(ctx, w, beat);
    s.paperPile(ctx, desk.x + 2, desk.y + 3, p.pile);
    const bounds = roomAt(layout, p.at).rect;
    if (run.bubble) s.speechBubble(ctx, w.x + 5, w.y - 1, run.bubble, Math.min(120, bounds.w - 4), bounds);
  }
}

/**
 * The mail carrier out on foot: delivering a run or on a round of mail, stopped at a cubicle while
 * they drop its letters.
 * @param {Ctx} ctx @param {number} t @param {Walkers['carrier']} carrier
 */
function drawCarrierOut(ctx, t, carrier) {
  if (carrier.pose === 'walking') s.walkingCarrier(ctx, carrier.x, carrier.y, carrier.still ? 0 : Math.floor(t / FRAME_MS), carrier.carrying, carrier.facing);
}

/** The office's looks, for the cubicles they were worked out for. @type {{ key: string, looks: Map<string, import('./looks.js').Look> } | null} */
let looksMade = null;

/**
 * The look of whoever works at `place` (looks.js), or of the temp in helper slot `temp`:
 * everyone in the office has their own.
 * @param {Scene} scene @param {import('./scene.js').Place} place @param {number | null} [temp]
 */
function lookAt(scene, place, temp = null) {
  const keys = workerKeys(scene.cubicles);
  const key = keys.join('|');
  if (looksMade?.key !== key) looksMade = { key, looks: looksFor(keys) };
  return looksMade.looks.get(temp != null ? `temp:${temp % TEMPS}` : lookKey(place)) ?? PLAIN;
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
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {Walkers} walking
 */
function drawJobWorkers(ctx, layout, scene, walking) {
  const run = scene.run;
  // the run's worker is on the floor once the mail carrier has arrived
  const arrived = run && !!walking.worker;
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
      s.worker(ctx, w, 0, lookAt(scene, place));
      s.jobGear(ctx, j.worker, w, desk, null);
    }
  }
}

/**
 * The office's ambient life: the residents at their desks in their idle poses, those out on a
 * break (on their way with a mug back from the water cooler), and the night janitor.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t @param {Walkers} walking
 */
function drawAmbient(ctx, layout, scene, t, walking) {
  const frame = Math.floor(t / FRAME_MS);
  const beat = Math.floor(t / 300);
  for (const r of walking.residents) {
    /** @type {import('./scene.js').Place} */
    const place = { room: 'cubicle', alias: r.alias };
    const desk = deskAt(layout, scene.cubicles, place);
    if (desk) s.resident(ctx, workerRect(desk), r.pose, r.facing, beat, lookAt(scene, place));
  }
  for (const w of walking.strollers) {
    const back = w.pose === 'walking' && w.to.kind === 'cooler' && w.facing === 'right';
    s.strollingWorker(ctx, w.x, w.y, w.pose === 'walking' ? frame : null, w.facing, { mug: back }, lookAt(scene, { room: 'cubicle', alias: w.alias }));
    if (w.pose === 'standing' && w.to.kind === 'chat') s.chatDots(ctx, w.x - 6, w.y + 2, beat + 4);
  }
  if (walking.janitor) s.nightJanitor(ctx, walking.janitor.x, walking.janitor.y, Math.floor(t / 400), walking.janitor.facing);
}

/**
 * The colleagues helping the active run with its subagents: walking over (or back), or standing at
 * the run's desk facing the worker, with a tag saying which tool their subagent is using.
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {number} t @param {Walkers} walking
 */
function drawHelpers(ctx, layout, scene, t, walking) {
  const frame = Math.floor(t / FRAME_MS);
  for (const h of walking.helpers) {
    const look = lookAt(scene, { room: 'cubicle', alias: h.recruit ?? '' }, h.recruit ? null : h.slot);
    s.strollingWorker(ctx, h.x, h.y, h.pose === 'walking' ? frame : null, h.facing, { lanyard: !h.recruit }, look);
    if (h.pose === 'standing' && h.activity) {
      const bounds = placeRect(layout, scene.cubicles, /** @type {import('./scene.js').SceneHelper} */ (scene.helpers.find((x) => x.id === h.id)).place) ?? layout.rooms.bullpen.rect;
      s.toolTag(ctx, h.x + 5, h.y - 1, toolOf(h.activity), bounds);
    }
  }
}

/** The tool in a subagent's activity (`Bash: git diff` → `Bash`), or that it's writing. @param {string} activity */
const toolOf = (activity) => (activity.startsWith('writing') ? 'write' : activity.split(':')[0].trim());

/**
 * At night, the lights down everywhere but where someone's in: the Queue room and the Review room
 * (the carrier and the boss work late), the active run's room, and each room with a worker at
 * their desk (a scheduled job's, or one its last run left there).
 * @param {Ctx} ctx @param {Layout} layout @param {Scene} scene @param {Walkers} walking
 */
function drawLightsDown(ctx, layout, scene, walking) {
  /** @type {Array<Rect | null>} */
  const lit = [layout.rooms.queueRoom.rect, layout.rooms.review.rect];
  if (walking.worker?.at) lit.push(placeRect(layout, scene.cubicles, walking.worker.at));
  scene.cubicles.forEach((c, i) => {
    if (c.jobs.length) lit.push(layout.cubicles[i] ?? null);
  });
  for (const o of scene.outcomes) if (WORKER_STATES.has(o.state) && o.state !== 'home') lit.push(placeRect(layout, scene.cubicles, o.place));
  s.lightsDown(ctx, layout.width, layout.height, /** @type {Rect[]} */ (lit.filter(Boolean)));
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
    const look = lookAt(scene, o.place);
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
        s.worker(ctx, w, 0, look);
        s.bandage(ctx, w);
        if (gear) s.jobGear(ctx, gear, w, desk, null);
        break;
      case 'asleep':
        s.sleepingWorker(ctx, w, desk.y, look);
        s.zzz(ctx, w.x + 9, desk.y - 12, Math.floor(t / 500));
        break;
      case 'dizzy': {
        const sway = { ...w, x: w.x + (Math.floor(t / 400) % 2) };
        s.worker(ctx, sway, 0, look);
        if (gear) s.jobGear(ctx, gear, sway, desk, null);
        s.flushed(ctx, sway);
        s.dizzyStars(ctx, sway.x + 1, sway.y - 4, Math.floor(t / 200));
        break;
      }
      case 'shrug': {
        s.shruggingWorker(ctx, w, look);
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
 * the overflow is a pile), but those the mail carrier hasn't dropped yet, and a sticky note while
 * issues wait for a human.
 * @param {Ctx} ctx @param {Rect} r the cubicle @param {import('./scene.js').SceneCubicle} c @param {Map<string, Set<number>>} undelivered
 */
function drawPending(ctx, r, c, undelivered) {
  const letters = trayNow(c, undelivered);
  if (letters.length) {
    s.inTray(ctx, inTrayRect(r));
    for (const slot of inTraySlots(r, letters)) {
      s.letter(ctx, slot.rect, slot.letters.length);
      if (slot.letters.every((l) => l.blocked)) s.padlock(ctx, slot.rect);
    }
  }
  if (c.sticky.length) s.stickyNote(ctx, stickyNote(r), c.sticky.length);
}

/**
 * The boss: at their desk, walking over to the worker, reading over their shoulder, or walking back.
 * @param {Ctx} ctx @param {number} t @param {Walkers['boss']} p
 */
function drawBossFigure(ctx, t, p) {
  if (p.pose === 'walking') s.boss(ctx, p.x, p.y, { step: Math.floor(t / FRAME_MS), facing: p.facing });
  else if (p.pose === 'standing') s.boss(ctx, p.x, p.y, { facing: p.facing });
  else s.boss(ctx, p.x, p.y, { seated: true });
}

/**
 * @param {Ctx} ctx
 * @param {Layout} layout
 * @param {Scene} scene
 * @param {{ t: number, filter?: string | null, ambient?: { tzOffsetMin: number } }} o `t`: now on the
 *   scene's clock, for the animations. `filter`: the workspace the panel is filtered to, outlined.
 *   `ambient`: bring the office to life (walkers.js), on the viewer's clock.
 */
export function drawOffice(ctx, layout, scene, { t, filter = null, ambient }) {
  const { rooms } = layout;
  const walking = walkers(layout, scene.cubicles, scene, t, { ambient });
  const part = walking.part;
  ctx.clearRect(0, 0, layout.width, layout.height);
  for (const [id, floor] of /** @type {const} */ ([['review', 'wood'], ['joplin', 'wood'], ['freeform', 'carpet'], ['queueRoom', 'tile']])) {
    s.room(ctx, rooms[id].rect, rooms[id].name, floor, WALL, { plateRight: backWallDoorway(layout, id)?.x });
  }
  // the bullpen opens straight onto the corridor, and the side rooms onto it by their doorways
  s.room(ctx, rooms.bullpen.rect, rooms.bullpen.name, 'carpet', WALL, { open: true });
  for (const c of layout.corridors) s.corridor(ctx, c, WALL);
  for (const id of SIDE_ROOMS) {
    const d = layout.doorways[id];
    if (!d) continue;
    // each doorway's Door: face-on in a back wall, else edge-on, swinging into the room
    const open = walking.doors[id] ?? 0;
    const r = rooms[id].rect;
    if (backWallDoorway(layout, id)) {
      s.backDoorway(ctx, d, r.y + WALL);
      s.backDoor(ctx, d, r.y + WALL, open);
    } else {
      s.doorway(ctx, d);
      s.door(ctx, d, open, d.x > r.x ? -1 : 1);
    }
  }
  drawBoss(ctx, layout, part);
  drawJoplinRoom(ctx, layout);
  drawFreeformRoom(ctx, layout, part);

  const b = rooms.bullpen.rect;
  s.wallWindow(ctx, b.x + 10, b.y + 6, 40, part);
  scene.cubicles.forEach((c, i) => {
    const r = layout.cubicles[i];
    if (!r) return;
    s.cubicle(ctx, r, cubicleDesks(r, deskOwners(c).length), c.name);
    drawPending(ctx, r, c, walking.undelivered);
    if (c.doNotDisturb) s.doNotDisturb(ctx, r);
    if (c.alias === filter) s.selected(ctx, r);
  });

  s.frontDoor(ctx, layout.door);
  if (scene.backInFive) s.backInFive(ctx, layout.door);
  if (scene.queueRoom.countdownMs != null) s.countdownClock(ctx, layout.clock, formatClock(scene.queueRoom.countdownMs));
  if (walking.carrier.pose === 'standing') s.mailCarrier(ctx, walking.carrier.x, walking.carrier.y);
  s.frontDesk(ctx, layout.desk);
  s.mailCart(ctx, layout.cart);
  for (const slot of cartSlots(layout, scene.queueRoom.letters)) s.letter(ctx, slot.rect, slot.pile);
  s.plant(ctx, clearRight(layout, 'queueRoom') - 14, rooms.queueRoom.rect.y + WALL + 4);
  drawJobWorkers(ctx, layout, scene, walking);
  drawOutcomes(ctx, layout, scene, t);
  drawAmbient(ctx, layout, scene, t, walking);
  drawHelpers(ctx, layout, scene, t, walking);
  if (part === 'night' && ambient && !scene.dark) drawLightsDown(ctx, layout, scene, walking);
  drawRun(ctx, layout, scene, t, walking);
  drawCarrierOut(ctx, t, walking.carrier);
  drawBossFigure(ctx, t, walking.boss);
  drawFolders(ctx, layout, scene);

  if (scene.dark) {
    s.darkness(ctx, layout.width, layout.height);
    s.exitSign(ctx, layout.door);
  }
}
