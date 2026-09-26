// Draws the office floor: a scene (scene.js) placed on a layout (layout.js) with the sprites
// (sprites.js), at the layout's internal resolution. The page scales the result up by a whole
// number. Not tested: the rules live in the reducer, and this only draws.
import { formatClock } from './format.js';
import { WALL, cartSlots } from './layout.js';
import * as s from './sprites.js';

/** @typedef {import('./sprites.js').Ctx} Ctx */

/** @param {Ctx} ctx @param {import('./layout.js').Rect} r */
function drawBoss(ctx, r) {
  s.wallWindow(ctx, r.x + 12, r.y + 6, 36);
  s.bossDesk(ctx, r.x + Math.floor(r.w / 2) - 28, r.y + WALL + 30);
  s.plant(ctx, r.x + 6, r.y + WALL + 4);
  s.cabinets(ctx, r.x + r.w - 26, r.y + WALL + 2, 2);
}

/** @param {Ctx} ctx @param {import('./layout.js').Rect} r */
function drawLibrary(ctx, r) {
  s.bookshelf(ctx, r.x + 6, r.y + 3, Math.min(60, r.w - 70));
  s.bookshelf(ctx, r.x + 6, r.y + WALL + 4, 40);
  s.table(ctx, r.x + Math.floor(r.w / 2) - 10, r.y + WALL + 34);
  s.plant(ctx, r.x + r.w - 14, r.y + r.h - 16);
}

/** @param {Ctx} ctx @param {import('./layout.js').Rect} r */
function drawAnnex(ctx, r) {
  s.wallWindow(ctx, r.x + 8, r.y + 6, 30);
  s.desk(ctx, r.x + 20, r.y + WALL + 30, 40);
  s.cabinets(ctx, r.x + r.w - 36, r.y + WALL + 2, 3);
  s.waterCooler(ctx, r.x + 6, r.y + WALL + 4);
}

/**
 * @param {Ctx} ctx
 * @param {import('./layout.js').Layout} layout
 * @param {import('./scene.js').Scene} scene
 */
export function drawOffice(ctx, layout, scene) {
  const { rooms } = layout;
  ctx.clearRect(0, 0, layout.width, layout.height);
  s.room(ctx, rooms.boss.rect, rooms.boss.name, 'wood', WALL);
  s.room(ctx, rooms.library.rect, rooms.library.name, 'wood', WALL);
  s.room(ctx, rooms.annex.rect, rooms.annex.name, 'carpet', WALL);
  s.room(ctx, rooms.reception.rect, rooms.reception.name, 'tile', WALL);
  s.room(ctx, rooms.bullpen.rect, rooms.bullpen.name, 'carpet', WALL);
  drawBoss(ctx, rooms.boss.rect);
  drawLibrary(ctx, rooms.library.rect);
  drawAnnex(ctx, rooms.annex.rect);

  const b = rooms.bullpen.rect;
  s.wallWindow(ctx, b.x + 10, b.y + 6, 40);
  scene.cubicles.forEach((c, i) => layout.cubicles[i] && s.cubicle(ctx, layout.cubicles[i], c));

  s.frontDoor(ctx, layout.door, scene.backInFive);
  if (scene.reception.countdownMs != null) s.countdownClock(ctx, layout.clock, formatClock(scene.reception.countdownMs));
  s.mailCarrier(ctx, layout.desk.x + 30, layout.desk.y - 16);
  s.receptionDesk(ctx, layout.desk);
  s.mailCart(ctx, layout.cart);
  for (const slot of cartSlots(layout, scene.reception.letters)) s.letter(ctx, slot.rect, slot.pile);
  s.plant(ctx, rooms.reception.rect.x + rooms.reception.rect.w - 14, rooms.reception.rect.y + WALL + 4);

  if (scene.dark) {
    s.darkness(ctx, layout.width, layout.height);
    s.exitSign(ctx, layout.door);
  }
}
