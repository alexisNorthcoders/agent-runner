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
 * The area a place takes up on the floor: its cubicle, or its whole room. Null when `place` names
 * a cubicle the layout doesn't have.
 * @param {Layout} layout @param {Array<{ alias: string }>} cubicles the scene's, in the layout's order
 * @param {import('./scene.js').Place} place
 * @returns {Rect | null}
 */
export function placeRect(layout, cubicles, place) {
  if (place.room !== 'cubicle') return layout.rooms[place.room].rect;
  return layout.cubicles[cubicles.findIndex((c) => c.alias === place.alias)] ?? null;
}

/**
 * A place's name, as on its sign: the cubicle's department sign, or the room's name plate.
 * @param {Layout} layout @param {Array<{ alias: string, name: string }>} cubicles @param {import('./scene.js').Place} place
 */
export function placeName(layout, cubicles, place) {
  if (place.room !== 'cubicle') return layout.rooms[place.room].name;
  const { alias } = place;
  return cubicles.find((c) => c.alias === alias)?.name ?? alias;
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
 * `items` in slots, one each up to `capacity`. When there are more, the last slot holds the rest.
 * @template T
 * @param {T[]} items @param {number} capacity @param {(i: number) => Rect} rect
 * @returns {Array<{ rect: Rect, items: T[] }>}
 */
function fillSlots(items, capacity, rect) {
  const over = items.length > capacity;
  const shown = over ? capacity - 1 : items.length;
  const slots = items.slice(0, shown).map((it, i) => ({ rect: rect(i), items: [it] }));
  if (over) slots.push({ rect: rect(shown), items: items.slice(shown) });
  return slots;
}

/**
 * The mail cart's slots, one per letter up to its capacity. When there are more letters than
 * slots, the last slot is a pile standing for the rest.
 * @param {Layout} layout
 * @param {Array<{ label: string }>} letters oldest first
 * @returns {Array<{ rect: Rect, label: string, pile: number }>} `pile`: how many letters the slot holds
 */
export function cartSlots(layout, letters) {
  const c = layout.cart;
  /** @param {number} i */
  const rect = (i) => ({ x: c.x + 3 + (i % CART_COLS) * 9, y: c.y + 3 + Math.floor(i / CART_COLS) * 8, w: 8, h: 6 });
  return fillSlots(letters, CART_CAPACITY, rect).map(({ rect: r, items }) => ({
    rect: r,
    label: items.length > 1 ? `+${items.length} more: ${items.map((l) => l.label).join(' · ')}` : items[0].label,
    pile: items.length,
  }));
}

/** Letters in a cubicle's in-tray: rows, and at most this many columns. */
const TRAY_ROWS = 2;
const TRAY_COLS = 6;

/**
 * A cubicle's in-tray, on the floor in front of its desk, on the left.
 * @param {Rect} r the cubicle
 * @returns {Rect & { cols: number }}
 */
export function inTrayRect(r) {
  const d = cubicleDesk(r);
  const cols = Math.max(1, Math.min(TRAY_COLS, Math.floor((r.w - 14) / 9)));
  return { x: r.x + 6, y: d.y + d.h + 4, w: cols * 9 + 3, h: TRAY_ROWS * 8 + 2, cols };
}

/**
 * The in-tray's slots, one per letter up to its capacity; the last holds the overflow.
 * @template {{ number: number }} L
 * @param {Rect} r the cubicle @param {L[]} letters in the order they're shown
 * @returns {Array<{ rect: Rect, letters: L[] }>}
 */
export function inTraySlots(r, letters) {
  const t = inTrayRect(r);
  /** @param {number} i */
  const rect = (i) => ({ x: t.x + 2 + (i % t.cols) * 9, y: t.y + 2 + Math.floor(i / t.cols) * 8, w: 8, h: 6 });
  return fillSlots(letters, t.cols * TRAY_ROWS, rect).map(({ rect: s, items }) => ({ rect: s, letters: items }));
}

/** The sticky note stuck on a cubicle's monitor, right of the worker. @param {Rect} r the cubicle */
export function stickyNote(r) {
  const d = cubicleDesk(r);
  return { x: d.x + Math.floor(d.w / 2) + 4, y: d.y - 10, w: 7, h: 7 };
}

/** The most folders the boss's desk holds. */
export const FOLDERS_MAX = 4;

/**
 * The folders on the boss's desk: one per room whose last run left a PR open (labelled with the
 * room), then one per parked PR (labelled with its issue). The last slot holds any overflow.
 * `tip`: what the hover says.
 * @param {Layout} layout @param {Array<{ alias: string, name: string }>} cubicles
 * @param {Array<Pick<import('./scene.js').SceneOutcome, 'place' | 'state' | 'label' | 'runId' | 'prUrl'>>} outcomes
 * @param {import('./scene.js').SceneParked[]} parked
 * @returns {Array<{ rect: Rect, tab: string, tip: string, parked: boolean, pile: number }>}
 */
export function folderSlots(layout, cubicles, outcomes, parked) {
  const d = layout.desks.boss;
  const items = [
    ...outcomes
      .filter((o) => o.state === 'folder')
      .map((o) => {
        const name = placeName(layout, cubicles, o.place);
        return { tab: name, tip: `${name}: PR open, ${o.label ?? o.runId}${o.prUrl ? `\nPR: ${o.prUrl}` : ''}`, parked: false };
      }),
    ...parked.map((p) => ({
      tab: `#${p.number}`,
      tip: `Parked: ${placeName(layout, cubicles, { room: 'cubicle', alias: p.alias })} #${p.number} ${p.title}\nPR: ${p.prUrl}`,
      parked: true,
    })),
  ];
  /** @param {number} i */
  const rect = (i) => ({ x: d.x + (i % 2) * 29, y: d.y - 1 - Math.floor(i / 2) * 9, w: 27, h: 8 });
  return fillSlots(items, FOLDERS_MAX, rect).map(({ rect: r, items: f }) =>
    f.length > 1
      ? { rect: r, tab: `+${f.length}`, tip: `${f.length} more:\n${f.map((x) => x.tip).join('\n')}`, parked: f.every((x) => x.parked), pile: f.length }
      : { rect: r, ...f[0], pile: 1 }
  );
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
