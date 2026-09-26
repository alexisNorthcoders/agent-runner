// Where everything on the office floor sits, in the scene's internal pixels. Wide: the bullpen in
// the middle, the boss's office and the Library on the left, Reception and the Annex on the right.
// Narrow: the rooms stacked, Reception first. No DOM here, so it can be tested in Node.

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {'reception' | 'bullpen' | 'boss' | 'annex' | 'library'} RoomId
 * @typedef {{ id: RoomId, name: string, rect: Rect }} Room
 * @typedef {{
 *   width: number,
 *   height: number,
 *   rooms: Record<RoomId, Room>,
 *   cubicles: Rect[],
 *   door: Rect,
 *   clock: Rect,
 *   desk: Rect,
 *   cart: Rect,
 *   desks: { boss: Rect, annex: Rect, library: Rect },
 * }} Layout
 *   `desk`: the reception desk. `desks`: the other rooms' desks (the Library's reading table).
 */

/** The height of a room's back wall, above its floor. */
export const WALL = 26;
/** The wide scene is always this tall; its width stretches between these to fill whole-number scales. */
export const WIDE_HEIGHT = 360;
export const WIDE_WIDTH = { min: 560, max: 720 };
/** The narrow (stacked) scene's width range. */
export const NARROW_WIDTH = { min: 240, max: 360 };
/** Letters on the mail cart: rows × columns. */
const CART_ROWS = 2;
const CART_COLS = 6;
export const CART_CAPACITY = CART_ROWS * CART_COLS;

const SIDE = 150;
const NAMES = { reception: 'RECEPTION', bullpen: 'MUNDER DIFFLIN', boss: "BOSS'S OFFICE", annex: 'ANNEX', library: 'LIBRARY' };

/** @param {RoomId} id @param {number} x @param {number} y @param {number} w @param {number} h @returns {Room} */
const room = (id, x, y, w, h) => ({ id, name: NAMES[id], rect: { x, y, w, h } });

/**
 * A grid of cubicles filling `area`, `cols` wide.
 * @param {number} count @param {Rect} area @param {number} cols @param {number} maxH
 * @returns {Rect[]}
 */
function grid(count, area, cols, maxH) {
  if (!count) return [];
  const c = Math.min(cols, count);
  const rows = Math.ceil(count / c);
  const w = Math.floor(area.w / c);
  const h = Math.min(maxH, Math.floor(area.h / rows));
  return Array.from({ length: count }, (_, i) => ({ x: area.x + (i % c) * w, y: area.y + Math.floor(i / c) * h, w, h }));
}

/** @param {Rect} r the Reception room */
function receptionParts(r) {
  return {
    door: { x: r.x + 10, y: r.y + 2, w: 20, h: WALL - 2 },
    clock: { x: r.x + 38, y: r.y + 6, w: 44, h: 13 },
    desk: { x: r.x + 44, y: r.y + 64, w: 72, h: 16 },
    cart: { x: r.x + 12, y: r.y + 108, w: CART_COLS * 9 + 4, h: 26 },
  };
}

/** @param {Record<RoomId, Room>} rooms */
function roomDesks(rooms) {
  const b = rooms.boss.rect;
  const a = rooms.annex.rect;
  const l = rooms.library.rect;
  return {
    boss: { x: b.x + Math.floor(b.w / 2) - 28, y: b.y + WALL + 30, w: 56, h: 16 },
    annex: { x: a.x + 20, y: a.y + WALL + 30, w: 40, h: 13 },
    library: { x: l.x + Math.floor(l.w / 2) - 10, y: l.y + WALL + 34, w: 40, h: 12 },
  };
}

/** A cubicle's desk. @param {Rect} r the cubicle */
export function cubicleDesk(r) {
  return { x: r.x + 8, y: r.y + 2 + Math.min(r.h - 20, 28), w: r.w - 16, h: 13 };
}

/**
 * The desk a worker sits behind, or null when `place` names a cubicle the layout doesn't have.
 * @param {Layout} layout @param {Array<{ alias: string }>} cubicles the scene's, in the layout's order
 * @param {import('./scene.js').Place} place
 * @returns {Rect | null}
 */
export function deskAt(layout, cubicles, place) {
  if (place.room !== 'cubicle') return layout.desks[place.room];
  const r = layout.cubicles[cubicles.findIndex((c) => c.alias === place.alias)];
  return r ? cubicleDesk(r) : null;
}

/**
 * The room a worker's place is in (a cubicle's is the bullpen).
 * @param {Layout} layout @param {import('./scene.js').Place} place
 * @returns {Room}
 */
export const roomAt = (layout, place) => layout.rooms[place.room === 'cubicle' ? 'bullpen' : place.room];

/** Where the worker sits at `desk`: left of the monitor, head and body above the desktop. @param {Rect} desk */
export const workerRect = (desk) => ({ x: desk.x + Math.floor(desk.w / 2) - 17, y: desk.y - 17, w: 10, h: 19 });

/**
 * The workspace whose cubicle (or the worker in it) is at (x, y), or null for anywhere else.
 * @param {Layout} layout @param {Array<{ alias: string }>} cubicles @param {number} x @param {number} y
 */
function cubicleAt(layout, cubicles, x, y) {
  const i = layout.cubicles.findIndex((r) => inside(r, x, y));
  return cubicles[i]?.alias ?? null;
}

/**
 * The panel's workspace filter after a click at (x, y): a cubicle's workspace, or none when the
 * click is on the filtered cubicle again or anywhere else.
 * @param {Layout} layout @param {Array<{ alias: string }>} cubicles @param {number} x @param {number} y
 * @param {string | null} current
 * @returns {string | null}
 */
export function clickFilter(layout, cubicles, x, y, current) {
  const alias = cubicleAt(layout, cubicles, x, y);
  return alias === current ? null : alias;
}

/**
 * @param {number} count cubicles
 * @param {'wide' | 'narrow'} mode
 * @param {number} width internal width, within the mode's range
 * @returns {Layout}
 */
export function layoutOffice(count, mode, width) {
  if (mode === 'wide') {
    const W = Math.max(WIDE_WIDTH.min, Math.min(WIDE_WIDTH.max, Math.floor(width)));
    const H = WIDE_HEIGHT;
    const rooms = {
      boss: room('boss', 0, 0, SIDE, 160),
      library: room('library', 0, 160, SIDE, H - 160),
      bullpen: room('bullpen', SIDE, 0, W - 2 * SIDE, H),
      reception: room('reception', W - SIDE, 0, SIDE, 190),
      annex: room('annex', W - SIDE, 190, SIDE, H - 190),
    };
    const b = rooms.bullpen.rect;
    const cubicles = grid(count, { x: b.x + 6, y: b.y + WALL + 6, w: b.w - 12, h: b.h - WALL - 12 }, 4, 100);
    return { width: W, height: H, rooms, cubicles, ...receptionParts(rooms.reception.rect), desks: roomDesks(rooms) };
  }
  const W = Math.max(NARROW_WIDTH.min, Math.min(NARROW_WIDTH.max, Math.floor(width)));
  const cols = W >= 300 ? 3 : 2;
  const rows = Math.ceil(count / cols);
  const cubeH = 90;
  let y = 0;
  /** @param {RoomId} id @param {number} h */
  const stack = (id, h) => {
    const r = room(id, 0, y, W, h);
    y += h;
    return r;
  };
  const rooms = {
    reception: stack('reception', 150),
    bullpen: stack('bullpen', WALL + 12 + Math.max(1, rows) * cubeH),
    boss: stack('boss', 110),
    annex: stack('annex', 110),
    library: stack('library', 110),
  };
  const b = rooms.bullpen.rect;
  const cubicles = grid(count, { x: b.x + 6, y: b.y + WALL + 6, w: b.w - 12, h: rows * cubeH }, cols, cubeH);
  return { width: W, height: y, rooms, cubicles, ...receptionParts(rooms.reception.rect), desks: roomDesks(rooms) };
}

/**
 * The mail cart's slots, one per letter up to its capacity. When there are more letters than
 * slots, the last slot is a pile standing for the rest.
 * @param {Layout} layout
 * @param {Array<{ label: string }>} letters oldest first
 * @returns {Array<{ rect: Rect, label: string, pile: number }>} `pile`: how many letters the slot holds
 */
export function cartSlots(layout, letters) {
  const over = letters.length > CART_CAPACITY;
  const shown = over ? CART_CAPACITY - 1 : letters.length;
  const c = layout.cart;
  /** @param {number} i */
  const rect = (i) => ({ x: c.x + 3 + (i % CART_COLS) * 9, y: c.y + 3 + Math.floor(i / CART_COLS) * 8, w: 8, h: 6 });
  const slots = letters.slice(0, shown).map((l, i) => ({ rect: rect(i), label: l.label, pile: 1 }));
  if (over) {
    const rest = letters.slice(shown);
    slots.push({ rect: rect(shown), label: `+${rest.length} more: ${rest.map((l) => l.label).join(' · ')}`, pile: rest.length });
  }
  return slots;
}

/** @param {Rect} r @param {number} x @param {number} y */
export const inside = (r, x, y) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

/**
 * The scene's size and whole-number scale for a box of `cssWidth` × `cssHeight` CSS pixels:
 * stacked rooms when it's narrower than the wide scene, else the wide scene at the largest scale
 * that fits, stretched to fill the width.
 * @param {number} cssWidth @param {number} cssHeight @param {number} dpr devicePixelRatio
 * @returns {{ mode: 'wide' | 'narrow', width: number, scale: number }}
 */
export function fitScene(cssWidth, cssHeight, dpr) {
  const w = cssWidth * dpr;
  if (cssWidth < WIDE_WIDTH.min) {
    const scale = Math.max(1, Math.floor(w / NARROW_WIDTH.min));
    return { mode: 'narrow', width: Math.max(NARROW_WIDTH.min, Math.min(NARROW_WIDTH.max, Math.floor(w / scale))), scale };
  }
  const scale = Math.max(1, Math.min(Math.floor(w / WIDE_WIDTH.min), Math.floor((cssHeight * dpr) / WIDE_HEIGHT)));
  return { mode: 'wide', width: Math.max(WIDE_WIDTH.min, Math.min(WIDE_WIDTH.max, Math.floor(w / scale))), scale };
}
