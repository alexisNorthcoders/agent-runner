// Where everything on the office floor sits, in the scene's internal pixels. Wide: the bullpen in
// the middle, the Review room and the Joplin room on the left, the Queue room and the Freeform room
// on the right, a corridor between each side and the bullpen, and an aisle in front of each row of
// cubicles. Narrow: the rooms stacked, the Queue room first, with a corridor lane down their right
// edge and an aisle in front of each row of cubicles. Also the walk graph the walkers route over.
// No DOM here, so it can be tested in Node.

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ x: number, y: number }} Point
 * @typedef {'queueRoom' | 'bullpen' | 'review' | 'freeform' | 'joplin'} RoomId
 * @typedef {Exclude<RoomId, 'bullpen'>} SideRoomId
 * @typedef {{ id: RoomId, name: string, rect: Rect }} Room
 * @typedef {{
 *   width: number,
 *   height: number,
 *   rooms: Record<RoomId, Room>,
 *   cubicles: Rect[],
 *   corridors: Rect[],
 *   aisles: Rect[],
 *   doorways: Partial<Record<SideRoomId, Rect>>,
 *   door: Rect,
 *   clock: Rect,
 *   desk: Rect,
 *   cart: Rect,
 *   desks: { review: Rect, freeform: Rect, joplin: Rect },
 * }} Layout
 *   `desk`: the front desk. `desks`: the other rooms' desks (the Joplin room's reading table).
 *   `corridors`: wide, the Corridors either side of the bullpen, left then right; narrow, the lane
 *   down the right edge (their back wall included). `aisles`: one in front of each row of cubicles,
 *   joining the corridors. `doorways`: each side room's way onto its corridor: wide, the gap in its
 *   wall facing the bullpen; narrow, the opening in its back wall at the lane's end, down to the
 *   floor, and its threshold just past the wall.
 */

/** The side rooms, the ones with a doorway onto a corridor. @type {SideRoomId[]} */
export const SIDE_ROOMS = ['review', 'joplin', 'freeform', 'queueRoom'];

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
/** A corridor's width, an aisle's depth, a doorway's height (wide) or width (narrow), and a wide cubicle's full height. */
const CORRIDOR = 14;
const AISLE = 10;
const DOORWAY = 16;
/** Narrow: how far below the top of the back wall a doorway in it starts, and how far past the wall onto the floor its threshold runs. */
export const DOORWAY_TOP = 4;
export const THRESHOLD = 4;
const CUBE_H = 100;
const NAMES = { queueRoom: 'QUEUE', bullpen: 'HEADLESS INC.', review: 'REVIEW', freeform: 'FREEFORM', joplin: 'JOPLIN' };

/** @param {RoomId} id @param {number} x @param {number} y @param {number} w @param {number} h @returns {Room} */
const room = (id, x, y, w, h) => ({ id, name: NAMES[id], rect: { x, y, w, h } });

/**
 * A grid of cubicles filling `area`, `cols` wide, at most `maxH` tall (fitting `area`'s height when
 * it has one), rows `gap` apart.
 * @param {number} count @param {Rect} area @param {number} cols @param {number} maxH @param {number} [gap]
 * @returns {Rect[]}
 */
function grid(count, area, cols, maxH, gap = 0) {
  if (!count) return [];
  const c = Math.min(cols, count);
  const rows = Math.ceil(count / c);
  const w = Math.floor(area.w / c);
  const h = area.h ? Math.min(maxH, Math.floor(area.h / rows)) : maxH;
  return Array.from({ length: count }, (_, i) => ({ x: area.x + (i % c) * w, y: area.y + Math.floor(i / c) * (h + gap), w, h }));
}

/** @param {Rect} r the Queue room */
function queueRoomParts(r) {
  return {
    door: { x: r.x + 10, y: r.y + 2, w: 20, h: WALL - 2 },
    clock: { x: r.x + 38, y: r.y + 6, w: 44, h: 13 },
    desk: { x: r.x + 44, y: r.y + 64, w: 72, h: 16 },
    cart: { x: r.x + 12, y: r.y + 108, w: CART_COLS * 9 + 4, h: 26 },
  };
}

/** @param {Record<RoomId, Room>} rooms */
function roomDesks(rooms) {
  const b = rooms.review.rect;
  const a = rooms.freeform.rect;
  const l = rooms.joplin.rect;
  return {
    review: { x: b.x + Math.floor(b.w / 2) - 28, y: b.y + WALL + 30, w: 56, h: 16 },
    freeform: { x: a.x + 20, y: a.y + WALL + 30, w: 40, h: 13 },
    joplin: { x: l.x + Math.floor(l.w / 2) - 10, y: l.y + WALL + 34, w: 40, h: 12 },
  };
}

/** A cubicle's desk, with room at each end to walk round it to the chair. @param {Rect} r the cubicle */
export function cubicleDesk(r) {
  return { x: r.x + 12, y: r.y + 2 + Math.min(r.h - 20, 28), w: r.w - 24, h: 13 };
}

/** The gap between desks side by side in a cubicle. */
const DESK_GAP = 2;

/**
 * A cubicle's `n` desks, side by side across the width of its one desk.
 * @param {Rect} r the cubicle @param {number} n
 * @returns {Rect[]}
 */
export function cubicleDesks(r, n) {
  const d = cubicleDesk(r);
  if (n <= 1) return [d];
  const w = Math.floor((d.w - (n - 1) * DESK_GAP) / n);
  return Array.from({ length: n }, (_, i) => ({ ...d, x: d.x + i * (w + DESK_GAP), w }));
}

/**
 * @typedef {{ alias: string, workspace?: boolean, jobs?: Array<{ name: string }> }} CubicleDesks
 *   A scene cubicle, as far as its desks go: the workspace's own (unless `workspace` is false), then
 *   one per scheduled job.
 */

/**
 * Who sits at each of a cubicle's desks, in order: null for the workspace's own worker, else a job's name.
 * @param {CubicleDesks} c
 * @returns {Array<string | null>}
 */
export const deskOwners = (c) => [...(c.workspace === false ? [] : [null]), ...(c.jobs ?? []).map((j) => j.name)];

/**
 * The desk a worker sits behind, or null when `place` names a cubicle (or a job's desk) the
 * layout doesn't have.
 * @param {Layout} layout @param {CubicleDesks[]} cubicles the scene's, in the layout's order
 * @param {import('./scene.js').Place} place
 * @returns {Rect | null}
 */
export function deskAt(layout, cubicles, place) {
  if (place.room !== 'cubicle') return layout.desks[place.room];
  const i = cubicles.findIndex((c) => c.alias === place.alias);
  const r = layout.cubicles[i];
  if (!r) return null;
  const owners = deskOwners(cubicles[i]);
  const at = owners.indexOf(place.job ?? null);
  return at < 0 ? null : cubicleDesks(r, owners.length)[at];
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

/**
 * Where the worker sits at `desk`: left of the monitor (at a narrow desk, at its left end), head and
 * body above the desktop.
 * @param {Rect} desk
 */
export const workerRect = (desk) => ({ x: desk.x + Math.max(1, Math.floor(desk.w / 2) - 17), y: desk.y - 17, w: 10, h: 19 });

/**
 * The workspace whose cubicle (or the worker in it) is at (x, y), or null for anywhere else
 * (a scheduled-job room that isn't a workspace included).
 * @param {Layout} layout @param {Array<{ alias: string, workspace?: boolean }>} cubicles @param {number} x @param {number} y
 */
function cubicleAt(layout, cubicles, x, y) {
  const c = cubicles[layout.cubicles.findIndex((r) => inside(r, x, y))];
  return c && c.workspace !== false ? c.alias : null;
}

/**
 * The panel's workspace filter after a click at (x, y): a cubicle's workspace, or none when the
 * click is on the filtered cubicle again or anywhere else.
 * @param {Layout} layout @param {Array<{ alias: string, workspace?: boolean }>} cubicles @param {number} x @param {number} y
 * @param {string | null} current
 * @returns {string | null}
 */
export function clickFilter(layout, cubicles, x, y, current) {
  const alias = cubicleAt(layout, cubicles, x, y);
  return alias === current ? null : alias;
}

/** Where the mail carrier sets off, in front of the front desk (feet). @param {Layout} layout @returns {Point} */
export const frontDeskStart = (layout) => ({ x: layout.desk.x + 30, y: layout.desk.y + layout.desk.h + 14 });

/**
 * Where a run is handed over, in front of its desk (feet); in a cubicle, inside its partitions.
 * @param {Rect} desk @param {Rect} [cubicle] the desk's cubicle
 * @returns {Point}
 */
export function approachPoint(desk, cubicle) {
  const p = { x: desk.x + Math.floor(desk.w / 2) + 4, y: desk.y + desk.h + 16 };
  if (!cubicle) return p;
  return { x: Math.max(cubicle.x + 4, Math.min(cubicle.x + cubicle.w - 13, p.x)), y: Math.min(p.y, cubicle.y + cubicle.h - 1) };
}

/**
 * A side room's doorway when it's in the room's back wall (narrow), else null.
 * @param {Layout} layout @param {SideRoomId} id
 * @returns {Rect | null}
 */
export function backWallDoorway(layout, id) {
  const d = layout.doorways[id];
  return d && d.y < layout.rooms[id].rect.y + WALL ? d : null;
}

/** A desk's place, as a key into the walk graph's approach points. @param {import('./scene.js').Place} p */
export const placeKey = (p) => (p.room === 'cubicle' ? `cubicle:${p.alias}:${p.job ?? ''}` : p.room);

/**
 * @typedef {{ edges: Array<[Point, Point]>, front: Point, approaches: Map<string, Point> }} WalkGraph
 *   Where walkers can go, as straight edges between points (where a walker's feet are, x at the
 *   left of their sprite). `front`: in front of the front desk. `approaches`: each desk's approach
 *   point, by `placeKey`.
 */

/**
 * The walk graph: along the Corridors and Aisles, out of each side room through its doorway, and
 * into each cubicle through its open front, to each desk's approach point. A room with no doorway,
 * or a cubicle with no aisle, is joined straight to the front desk.
 * @param {Layout} layout @param {CubicleDesks[]} cubicles the scene's, in the layout's order
 * @returns {WalkGraph}
 */
export function walkGraph(layout, cubicles) {
  /** @type {Array<[Point, Point]>} */
  const edges = [];
  /** @param {Point} a @param {Point} b */
  const link = (a, b) => {
    if (a.x !== b.x || a.y !== b.y) edges.push([a, b]);
  };
  const front = frontDeskStart(layout);
  /** @type {Map<string, Point>} */
  const approaches = new Map();
  // walkers keep to the middle of a corridor and the front of an aisle
  const lanes = layout.corridors.map((c) => c.x + Math.floor((c.w - 9) / 2));
  /** Where walkers' feet go across an aisle or through a doorway: near its front. @param {Rect} r */
  const lane = (r) => r.y + r.h - 3;
  // the stops along each corridor (y) and each aisle (x), joined up in order at the end
  const corridorStops = lanes.map(() => new Set(layout.aisles.map(lane)));
  const aisleStops = layout.aisles.map(() => new Set(lanes));

  /**
   * Out of a side room from `p` and through its doorway to the corridor: through a side wall, down
   * or up the room to the doorway's lane first; through the back wall, across the room's floor to
   * under the doorway first, clear of the furniture along the wall.
   * @param {SideRoomId} id @param {Point} p
   */
  const leave = (id, p) => {
    const d = layout.doorways[id];
    if (!d) return link(p, front);
    const y = lane(d);
    const i = lanes.reduce((best, x, j) => (Math.abs(x - d.x) < Math.abs(lanes[best] - d.x) ? j : best), 0);
    corridorStops[i].add(y);
    const x = backWallDoorway(layout, id) ? d.x + Math.floor((d.w - 9) / 2) : p.x;
    link(p, { x, y: p.y });
    link({ x, y: p.y }, { x, y });
    link({ x, y }, { x: lanes[i], y });
  };
  leave('queueRoom', front);
  for (const id of /** @type {const} */ (['review', 'freeform', 'joplin'])) {
    const p = approachPoint(layout.desks[id]);
    approaches.set(id, p);
    leave(id, p);
  }
  cubicles.forEach((c, i) => {
    const r = layout.cubicles[i];
    if (!r) return;
    const owners = deskOwners(c);
    const aisle = layout.aisles.findIndex((a) => a.y === r.y + r.h);
    cubicleDesks(r, owners.length).forEach((desk, k) => {
      const p = approachPoint(desk, r);
      approaches.set(placeKey({ room: 'cubicle', alias: c.alias, job: owners[k] ?? undefined }), p);
      if (aisle < 0) return link(p, front);
      aisleStops[aisle].add(p.x);
      link(p, { x: p.x, y: lane(layout.aisles[aisle]) });
    });
  });
  /** @param {Set<number>} stops @param {(v: number) => Point} at */
  const chain = (stops, at) => {
    const sorted = [...stops].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) link(at(sorted[i - 1]), at(sorted[i]));
  };
  corridorStops.forEach((stops, i) => chain(stops, (y) => ({ x: lanes[i], y })));
  aisleStops.forEach((stops, i) => chain(stops, (x) => ({ x, y: lane(layout.aisles[i]) })));
  return { edges, front, approaches };
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
      review: room('review', 0, 0, SIDE, 160),
      joplin: room('joplin', 0, 160, SIDE, H - 160),
      bullpen: room('bullpen', SIDE + CORRIDOR, 0, W - 2 * (SIDE + CORRIDOR), H),
      queueRoom: room('queueRoom', W - SIDE, 0, SIDE, 190),
      freeform: room('freeform', W - SIDE, 190, SIDE, H - 190),
    };
    const b = rooms.bullpen.rect;
    const corridors = [
      { x: SIDE, y: 0, w: CORRIDOR, h: H },
      { x: W - SIDE - CORRIDOR, y: 0, w: CORRIDOR, h: H },
    ];
    // rows of cubicles, each with its aisle in front, from just under the back wall: full height
    // while they fit (up to 3 rows), else shared out so the last aisle still ends at the front
    const top = b.y + WALL + 2;
    const cols = 4;
    const rows = Math.max(1, Math.ceil(count / cols));
    const cubeH = Math.max(0, Math.min(CUBE_H, Math.floor((b.y + b.h - top) / rows) - AISLE));
    const cubicles = grid(count, { x: b.x + 6, y: top, w: b.w - 12, h: 0 }, cols, cubeH, AISLE);
    const aisles = Array.from({ length: rows }, (_, i) => ({ x: b.x, y: top + i * (cubeH + AISLE) + cubeH, w: b.w, h: AISLE }));
    /** @param {Rect} r @param {'left' | 'right'} side the wall facing the bullpen */
    const doorway = (r, side) => ({ x: side === 'left' ? r.x : r.x + r.w - 1, y: r.y + r.h - DOORWAY - 6, w: 1, h: DOORWAY });
    const doorways = {
      review: doorway(rooms.review.rect, 'right'),
      joplin: doorway(rooms.joplin.rect, 'right'),
      queueRoom: doorway(rooms.queueRoom.rect, 'left'),
      freeform: doorway(rooms.freeform.rect, 'left'),
    };
    return { width: W, height: H, rooms, cubicles, corridors, aisles, doorways, ...queueRoomParts(rooms.queueRoom.rect), desks: roomDesks(rooms) };
  }
  const W = Math.max(NARROW_WIDTH.min, Math.min(NARROW_WIDTH.max, Math.floor(width)));
  const cols = W >= 300 ? 3 : 2;
  const rows = Math.max(1, Math.ceil(count / cols));
  const cubeH = 90;
  // the rooms, stacked, leave the lane down the right edge
  const roomW = W - CORRIDOR;
  let y = 0;
  /** @param {RoomId} id @param {number} h */
  const stack = (id, h) => {
    const r = room(id, 0, y, roomW, h);
    y += h;
    return r;
  };
  const rooms = {
    queueRoom: stack('queueRoom', 150),
    bullpen: stack('bullpen', WALL + 12 + rows * (cubeH + AISLE)),
    review: stack('review', 110),
    freeform: stack('freeform', 110),
    joplin: stack('joplin', 110),
  };
  const b = rooms.bullpen.rect;
  const top = b.y + WALL + 6;
  const cubicles = grid(count, { x: b.x + 6, y: top, w: b.w - 12, h: 0 }, cols, cubeH, AISLE);
  const aisles = Array.from({ length: rows }, (_, i) => ({ x: b.x, y: top + i * (cubeH + AISLE) + cubeH, w: b.w, h: AISLE }));
  // an opening in the back wall at the lane's end, from under the wall's top trim down to the
  // floor, with a threshold on the floor (THRESHOLD deep) where walkers step out onto the lane. It
  // is the same for every room height, and the name plate and the furniture along the wall keep
  // left of it (officeView.js)
  /** @param {Rect} r */
  const doorway = (r) => ({ x: r.x + r.w - DOORWAY, y: r.y + DOORWAY_TOP, w: DOORWAY, h: WALL - DOORWAY_TOP + THRESHOLD });
  const doorways = { queueRoom: doorway(rooms.queueRoom.rect), review: doorway(rooms.review.rect), freeform: doorway(rooms.freeform.rect), joplin: doorway(rooms.joplin.rect) };
  return {
    width: W,
    height: y,
    rooms,
    cubicles,
    corridors: [{ x: roomW, y: 0, w: CORRIDOR, h: y }],
    aisles,
    doorways,
    ...queueRoomParts(rooms.queueRoom.rect),
    desks: roomDesks(rooms),
  };
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
  const d = layout.desks.review;
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
