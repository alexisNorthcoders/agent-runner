// The office's sprites, drawn procedurally with filled rectangles at the scene's internal
// resolution. Everything the view draws comes from here, so hand-made sprite sheets can replace
// these functions later without touching the scene or the view's placement.

/** @typedef {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} Ctx */
/** @typedef {import('./layout.js').Rect} Rect */

export const PALETTE = {
  wall: '#d9cfae',
  wallTrim: '#a8996e',
  carpet: '#6f7d8c',
  carpetDot: '#66737f',
  wood: '#9a6a3c',
  woodDark: '#6e4a28',
  woodFloor: '#b98d5a',
  woodFloorLine: '#a57c4c',
  tile: '#cfcabb',
  tileLine: '#bdb7a6',
  partition: '#8d94a3',
  partitionTop: '#b8bdc7',
  desk: '#c9b18a',
  deskEdge: '#9c8563',
  monitor: '#2d2f36',
  screen: '#86cfe8',
  chair: '#3b3f4a',
  paper: '#f4f1e8',
  ink: '#1d1d22',
  skin: '#e3b98f',
  hair: '#4a3222',
  uniform: '#2f5f9e',
  signBg: '#f4f1e8',
  signText: '#1d2b4a',
  red: '#c8323c',
  white: '#ffffff',
  green: '#3f8f4f',
  plant: '#3f8f4f',
  pot: '#a55a3a',
  led: '#ff5a4a',
  ledBg: '#141414',
  envelope: '#e9d9a8',
  envelopeEdge: '#b49a5a',
  books: ['#a33b3b', '#3b6ea3', '#3b8a4f', '#b08a2e', '#6b4a8a'],
  window: '#9fd0f0',
  night: 'rgba(6, 8, 22, 0.84)',
};

// --- pixel font (3×5, uppercase) ---

const GLYPHS = /** @type {Record<string, string>} */ ({
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '-': '000000111000000', ':': '000010000010000', '.': '000000000000010',
  '!': '010010010000010', '?': '110001010000010', '/': '001001010100100', '&': '010101010101011', "'": '010010000000000',
  '#': '101111101111101', _: '000000000000111', '+': '000010111010000', ',': '000000000010100', '(': '010100100100010',
  ')': '010001001001010',
});

/** Pixels per character, spacing included. */
export const CHAR_W = 4;

/** @param {string} s */
export const textWidth = (s) => (s.length ? s.length * CHAR_W - 1 : 0);

/** `s` upper-cased and cut to fit `maxW` pixels. @param {string} s @param {number} maxW */
export function fitText(s, maxW) {
  const up = s.toUpperCase();
  const n = Math.floor((maxW + 1) / CHAR_W);
  return up.length <= n ? up : `${up.slice(0, Math.max(0, n - 1))}.`;
}

/**
 * @param {Ctx} ctx @param {string} s @param {number} x @param {number} y top-left, or top-centre with `center`
 * @param {string} color @param {{ center?: boolean }} [o]
 */
export function text(ctx, s, x, y, color, o = {}) {
  const str = s.toUpperCase();
  let cx = Math.round(o.center ? x - textWidth(str) / 2 : x);
  ctx.fillStyle = color;
  for (const ch of str) {
    const g = GLYPHS[ch] ?? GLYPHS['?'];
    for (let i = 0; i < 15; i++) if (g[i] === '1') ctx.fillRect(cx + (i % 3), y + Math.floor(i / 3), 1, 1);
    cx += CHAR_W;
  }
}

// --- rooms ---

/** @param {Ctx} ctx @param {Rect} r @param {string} color @param {number} x @param {number} y @param {number} w @param {number} h */
const box = (ctx, r, color, x, y, w, h) => {
  ctx.fillStyle = color;
  ctx.fillRect(r.x + x, r.y + y, w, h);
};

/**
 * A room: its back wall (`wallH` tall) with a name plate, and its floor.
 * @param {Ctx} ctx @param {Rect} r @param {string} name @param {'carpet' | 'wood' | 'tile'} floor @param {number} wallH
 */
export function room(ctx, r, name, floor, wallH) {
  const [base, line] = floor === 'wood' ? [PALETTE.woodFloor, PALETTE.woodFloorLine] : floor === 'tile' ? [PALETTE.tile, PALETTE.tileLine] : [PALETTE.carpet, PALETTE.carpetDot];
  box(ctx, r, base, 0, wallH, r.w, r.h - wallH);
  ctx.fillStyle = line;
  if (floor === 'wood') for (let y = r.y + wallH + 5; y < r.y + r.h; y += 6) ctx.fillRect(r.x, y, r.w, 1);
  else if (floor === 'tile') {
    for (let y = r.y + wallH + 11; y < r.y + r.h; y += 12) ctx.fillRect(r.x, y, r.w, 1);
    for (let x = r.x + 11; x < r.x + r.w; x += 12) ctx.fillRect(x, r.y + wallH, 1, r.h - wallH);
  } else for (let y = r.y + wallH + 2; y < r.y + r.h; y += 4) for (let x = r.x + ((y >> 2) % 2) * 2; x < r.x + r.w; x += 4) ctx.fillRect(x, y, 1, 1);
  box(ctx, r, PALETTE.wall, 0, 0, r.w, wallH);
  box(ctx, r, PALETTE.wallTrim, 0, wallH - 2, r.w, 2);
  // outline, so neighbouring rooms read as separate
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(r.x, r.y, r.w, 1);
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  ctx.fillRect(r.x, r.y, 1, r.h);
  ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  const plate = fitText(name, r.w - 12);
  const pw = textWidth(plate) + 6;
  const px = r.x + r.w - pw - 4;
  ctx.fillStyle = PALETTE.signText;
  ctx.fillRect(px, r.y + 4, pw, 9);
  text(ctx, plate, px + 3, r.y + 6, PALETTE.signBg);
}

/** A window on a back wall. @param {Ctx} ctx @param {number} x @param {number} y @param {number} w */
export function wallWindow(ctx, x, y, w) {
  ctx.fillStyle = PALETTE.wallTrim;
  ctx.fillRect(x - 1, y - 1, w + 2, 14);
  ctx.fillStyle = PALETTE.window;
  ctx.fillRect(x, y, w, 12);
  ctx.fillStyle = PALETTE.white;
  ctx.fillRect(x + 2, y + 2, 3, 1);
  ctx.fillStyle = PALETTE.wallTrim;
  ctx.fillRect(x + Math.floor(w / 2), y, 1, 12);
}

// --- furniture ---

/** A desk seen from the front, with a monitor and chair behind it. @param {Ctx} ctx @param {number} x @param {number} y @param {number} w */
export function desk(ctx, x, y, w) {
  ctx.fillStyle = PALETTE.chair;
  ctx.fillRect(x + Math.floor(w / 2) - 4, y - 9, 8, 7);
  ctx.fillStyle = PALETTE.desk;
  ctx.fillRect(x, y, w, 6);
  ctx.fillStyle = PALETTE.deskEdge;
  ctx.fillRect(x, y + 6, w, 2);
  ctx.fillRect(x + 1, y + 8, 2, 5);
  ctx.fillRect(x + w - 3, y + 8, 2, 5);
  ctx.fillStyle = PALETTE.monitor;
  ctx.fillRect(x + Math.floor(w / 2) - 5, y - 6, 10, 7);
  ctx.fillStyle = PALETTE.screen;
  ctx.fillRect(x + Math.floor(w / 2) - 4, y - 5, 8, 4);
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(x + 3, y + 1, 5, 3);
}

/** @param {Ctx} ctx @param {number} x @param {number} y */
export function plant(ctx, x, y) {
  ctx.fillStyle = PALETTE.plant;
  ctx.fillRect(x + 1, y, 6, 5);
  ctx.fillRect(x, y + 2, 8, 3);
  ctx.fillStyle = PALETTE.pot;
  ctx.fillRect(x + 1, y + 5, 6, 5);
}

/** @param {Ctx} ctx @param {number} x @param {number} y */
export function waterCooler(ctx, x, y) {
  ctx.fillStyle = PALETTE.window;
  ctx.fillRect(x + 1, y, 6, 6);
  ctx.fillStyle = PALETTE.white;
  ctx.fillRect(x, y + 6, 8, 10);
  ctx.fillStyle = PALETTE.partition;
  ctx.fillRect(x + 3, y + 8, 2, 2);
}

/** Filing cabinets against a wall. @param {Ctx} ctx @param {number} x @param {number} y @param {number} n */
export function cabinets(ctx, x, y, n) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = PALETTE.partition;
    ctx.fillRect(x + i * 10, y, 9, 16);
    ctx.fillStyle = PALETTE.partitionTop;
    ctx.fillRect(x + i * 10 + 3, y + 3, 3, 1);
    ctx.fillRect(x + i * 10 + 3, y + 10, 3, 1);
  }
}

/** A bookshelf against a wall. @param {Ctx} ctx @param {number} x @param {number} y @param {number} w */
export function bookshelf(ctx, x, y, w) {
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(x, y, w, 22);
  for (let shelf = 0; shelf < 2; shelf++) {
    let bx = x + 2;
    let i = shelf * 3;
    while (bx < x + w - 3) {
      const bw = 2 + (i % 2);
      ctx.fillStyle = PALETTE.books[i % PALETTE.books.length];
      ctx.fillRect(bx, y + 2 + shelf * 10, bw, 8 - (i % 3));
      bx += bw + 1;
      i++;
    }
  }
}

/** The boss's big desk, with a mug. @param {Ctx} ctx @param {number} x @param {number} y */
export function bossDesk(ctx, x, y) {
  ctx.fillStyle = PALETTE.chair;
  ctx.fillRect(x + 22, y - 12, 12, 11);
  ctx.fillStyle = PALETTE.wood;
  ctx.fillRect(x, y, 56, 8);
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(x, y + 8, 56, 8);
  ctx.fillStyle = PALETTE.monitor;
  ctx.fillRect(x + 6, y - 5, 10, 6);
  ctx.fillStyle = PALETTE.white;
  ctx.fillRect(x + 44, y + 1, 4, 4);
  ctx.fillRect(x + 48, y + 2, 1, 2);
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(x + 26, y + 2, 8, 4);
}

/** A reading table. @param {Ctx} ctx @param {number} x @param {number} y */
export function table(ctx, x, y) {
  ctx.fillStyle = PALETTE.wood;
  ctx.fillRect(x, y, 40, 10);
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(x, y + 10, 40, 2);
  ctx.fillStyle = PALETTE.chair;
  ctx.fillRect(x + 6, y + 13, 7, 5);
  ctx.fillRect(x + 27, y + 13, 7, 5);
  ctx.fillStyle = PALETTE.books[1];
  ctx.fillRect(x + 16, y + 3, 7, 4);
}

// --- the bullpen ---

/**
 * A cubicle: partitions on three sides, a desk, and its department sign on the back partition.
 * @param {Ctx} ctx @param {Rect} r @param {{ name: string, doNotDisturb: boolean }} c
 */
export function cubicle(ctx, r, c) {
  const x = r.x + 2;
  const y = r.y + 2;
  const w = r.w - 4;
  const h = r.h - 4;
  ctx.fillStyle = PALETTE.partition;
  ctx.fillRect(x, y, w, 12);
  ctx.fillRect(x, y, 3, h);
  ctx.fillRect(x + w - 3, y, 3, h);
  ctx.fillStyle = PALETTE.partitionTop;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
  // department sign
  const name = fitText(c.name, w - 10);
  const sw = textWidth(name) + 4;
  ctx.fillStyle = PALETTE.signBg;
  ctx.fillRect(x + Math.floor((w - sw) / 2), y + 3, sw, 7);
  text(ctx, name, x + w / 2, y + 4, PALETTE.signText, { center: true });
  desk(ctx, x + 6, y + Math.min(h - 16, 28), w - 12);
  if (c.doNotDisturb) doNotDisturb(ctx, x + w - 3, y + 14);
}

/** A "Do not disturb" sign hanging on a partition, right edge at `x`. @param {Ctx} ctx @param {number} x @param {number} y */
export function doNotDisturb(ctx, x, y) {
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x - 16, y - 2, 1, 2);
  ctx.fillStyle = PALETTE.red;
  ctx.fillRect(x - 31, y, 31, 19);
  text(ctx, 'DO NOT', x - 15.5, y + 2, PALETTE.white, { center: true });
  text(ctx, 'DISTURB', x - 15.5, y + 10, PALETTE.white, { center: true });
}

// --- reception ---

/**
 * The front door, on the back wall, with "BACK IN 5" hung on it during a general pause.
 * @param {Ctx} ctx @param {Rect} r @param {boolean} backInFive
 */
export function frontDoor(ctx, r, backInFive) {
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 1);
  ctx.fillStyle = PALETTE.window;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = PALETTE.wallTrim;
  ctx.fillRect(r.x + Math.floor(r.w / 2), r.y, 1, r.h);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(r.x + Math.floor(r.w / 2) - 3, r.y + 12, 1, 3);
  ctx.fillRect(r.x + Math.floor(r.w / 2) + 3, r.y + 12, 1, 3);
  if (!backInFive) return;
  // a card on a string, wider than the door
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(r.x + 4, r.y + 2, 1, 5);
  ctx.fillRect(r.x + r.w - 5, r.y + 2, 1, 5);
  ctx.fillStyle = PALETTE.red;
  ctx.fillRect(r.x - 6, r.y + 6, r.w + 12, 15);
  text(ctx, 'BACK', r.x + r.w / 2, r.y + 7, PALETTE.white, { center: true });
  text(ctx, 'IN 5', r.x + r.w / 2, r.y + 14, PALETTE.white, { center: true });
}

/** An EXIT sign over the door: the only light left when the office is dark. @param {Ctx} ctx @param {Rect} door */
export function exitSign(ctx, door) {
  ctx.fillStyle = PALETTE.red;
  ctx.fillRect(door.x + Math.floor(door.w / 2) - 9, door.y - 1, 18, 7);
  text(ctx, 'EXIT', door.x + door.w / 2, door.y, PALETTE.white, { center: true });
}

/** The countdown clock: `label` in red LEDs. @param {Ctx} ctx @param {Rect} r @param {string} label */
export function countdownClock(ctx, r, label) {
  ctx.fillStyle = PALETTE.ledBg;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  text(ctx, fitText(label, r.w - 4), r.x + r.w / 2, r.y + 4, PALETTE.led, { center: true });
}

/** The mail carrier, seated behind the reception desk (head at `y`). @param {Ctx} ctx @param {number} x @param {number} y */
export function mailCarrier(ctx, x, y) {
  // cap
  ctx.fillStyle = PALETTE.uniform;
  ctx.fillRect(x + 1, y, 7, 2);
  ctx.fillRect(x + 6, y + 2, 3, 1);
  // head
  ctx.fillStyle = PALETTE.hair;
  ctx.fillRect(x + 1, y + 2, 6, 2);
  ctx.fillStyle = PALETTE.skin;
  ctx.fillRect(x + 2, y + 3, 5, 5);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(x + 5, y + 4, 1, 1);
  // body and arms
  ctx.fillStyle = PALETTE.uniform;
  ctx.fillRect(x, y + 8, 9, 8);
  ctx.fillStyle = PALETTE.skin;
  ctx.fillRect(x - 1, y + 14, 2, 2);
  ctx.fillRect(x + 8, y + 14, 2, 2);
}

/** The reception desk, a long counter. @param {Ctx} ctx @param {Rect} r */
export function receptionDesk(ctx, r) {
  ctx.fillStyle = PALETTE.wood;
  ctx.fillRect(r.x, r.y, r.w, 5);
  ctx.fillStyle = PALETTE.woodDark;
  ctx.fillRect(r.x, r.y + 5, r.w, r.h - 5);
  ctx.fillStyle = PALETTE.paper;
  ctx.fillRect(r.x + r.w - 14, r.y + 1, 6, 3);
  // the phone
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(r.x + 5, r.y + 1, 6, 3);
}

/** The mail cart (letters go on top of it). @param {Ctx} ctx @param {Rect} r */
export function mailCart(ctx, r) {
  ctx.fillStyle = PALETTE.partition;
  ctx.fillRect(r.x, r.y, r.w, r.h - 4);
  ctx.fillStyle = PALETTE.partitionTop;
  ctx.fillRect(r.x, r.y, r.w, 1);
  ctx.fillRect(r.x, r.y + 9, r.w, 1);
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(r.x + 2, r.y + r.h - 4, 3, 3);
  ctx.fillRect(r.x + r.w - 5, r.y + r.h - 4, 3, 3);
  ctx.fillRect(r.x + r.w, r.y - 4, 1, r.h - 6);
}

/** A letter (a queued request); `pile` > 1 draws a stack. @param {Ctx} ctx @param {Rect} r @param {number} pile */
export function letter(ctx, r, pile) {
  if (pile > 1) {
    ctx.fillStyle = PALETTE.envelopeEdge;
    ctx.fillRect(r.x + 1, r.y - 1, r.w, r.h);
  }
  ctx.fillStyle = PALETTE.envelope;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = PALETTE.envelopeEdge;
  ctx.fillRect(r.x + 1, r.y + 1, 1, 1);
  ctx.fillRect(r.x + r.w - 2, r.y + 1, 1, 1);
  ctx.fillRect(r.x + 2, r.y + 2, r.w - 4, 1);
  if (pile > 1) {
    ctx.fillStyle = PALETTE.red;
    ctx.fillRect(r.x + r.w - 3, r.y + r.h - 3, 3, 3);
  }
}

/** The lights off: a night tint over the whole office. @param {Ctx} ctx @param {number} w @param {number} h */
export function darkness(ctx, w, h) {
  ctx.fillStyle = PALETTE.night;
  ctx.fillRect(0, 0, w, h);
}
