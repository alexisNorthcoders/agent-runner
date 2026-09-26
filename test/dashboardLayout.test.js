import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CART_CAPACITY, cartSlots, clickFilter, cubicleDesk, deskAt, fitScene, inside, layoutOffice, placeRect, workerRect } from '../dashboard/layout.js';

/** @param {{ x: number, y: number, w: number, h: number }} a @param {{ x: number, y: number, w: number, h: number }} b */
const within = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
/** @param {{ x: number, y: number, w: number, h: number }} a @param {{ x: number, y: number, w: number, h: number }} b */
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('office layout', () => {
  for (const [mode, width] of /** @type {const} */ ([
    ['wide', 640],
    ['wide', 560],
    ['wide', 720],
    ['narrow', 240],
    ['narrow', 360],
  ])) {
    it(`fits the rooms and every cubicle (${mode} ${width})`, () => {
      for (const count of [0, 1, 4, 9, 13]) {
        const l = layoutOffice(count, mode, width);
        const all = { x: 0, y: 0, w: l.width, h: l.height };
        const rooms = Object.values(l.rooms).map((r) => r.rect);
        for (const r of rooms) assert.ok(within(r, all), `${mode} room ${JSON.stringify(r)}`);
        for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) assert.ok(!overlap(rooms[i], rooms[j]));
        assert.equal(l.cubicles.length, count);
        for (const c of l.cubicles) assert.ok(within(c, l.rooms.bullpen.rect), `cubicle ${JSON.stringify(c)}`);
        for (const part of [l.door, l.clock, l.desk, l.cart]) assert.ok(within(part, l.rooms.reception.rect));
        for (const id of /** @type {const} */ (['boss', 'annex', 'library'])) {
          assert.ok(within(l.desks[id], l.rooms[id].rect), `${id} desk`);
          assert.ok(within(workerRect(l.desks[id]), l.rooms[id].rect), `${id} worker`);
        }
        for (const c of l.cubicles) assert.ok(within(workerRect(cubicleDesk(c)), c), `worker in ${JSON.stringify(c)}`);
      }
    });
  }

  it('stacks the rooms full width when narrow', () => {
    const l = layoutOffice(9, 'narrow', 300);
    for (const r of Object.values(l.rooms)) assert.deepEqual([r.rect.x, r.rect.w], [0, 300]);
    assert.equal(l.rooms.reception.rect.y, 0);
  });

  it('puts one slot per letter on the mail cart, piling the overflow in the last one', () => {
    const l = layoutOffice(3, 'wide', 640);
    const letters = (n) => Array.from({ length: n }, (_, i) => ({ label: `L${i}` }));
    assert.deepEqual(cartSlots(l, letters(3)).map((s) => s.label), ['L0', 'L1', 'L2']);
    const full = cartSlots(l, letters(CART_CAPACITY + 2));
    assert.equal(full.length, CART_CAPACITY);
    assert.equal(full.at(-1).pile, 3);
    assert.match(full.at(-1).label, /^\+3 more: L11 · L12 · L13$/);
    for (const s of full) assert.ok(within(s.rect, l.cart));
    assert.ok(inside(full[0].rect, full[0].rect.x, full[0].rect.y));
  });
});

describe('workers and clicks on the floor', () => {
  const l = layoutOffice(3, 'wide', 640);
  const cubicles = [{ alias: 'bot' }, { alias: 'dots' }, { alias: 'chess' }];
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  it("finds a worker's desk: a cubicle's, the Annex's or the Library's", () => {
    assert.deepEqual(deskAt(l, cubicles, { room: 'cubicle', alias: 'dots' }), cubicleDesk(l.cubicles[1]));
    assert.deepEqual(deskAt(l, cubicles, { room: 'annex' }), l.desks.annex);
    assert.deepEqual(deskAt(l, cubicles, { room: 'library' }), l.desks.library);
    assert.equal(deskAt(l, cubicles, { room: 'cubicle', alias: 'gone' }), null);
  });

  it("finds a place's area, for its last run's scene and hover: its cubicle, or its room", () => {
    assert.deepEqual(placeRect(l, cubicles, { room: 'cubicle', alias: 'chess' }), l.cubicles[2]);
    assert.deepEqual(placeRect(l, cubicles, { room: 'annex' }), l.rooms.annex.rect);
    assert.deepEqual(placeRect(l, cubicles, { room: 'library' }), l.rooms.library.rect);
    assert.equal(placeRect(l, cubicles, { room: 'cubicle', alias: 'gone' }), null);
  });

  it('filters to a cubicle (or its worker) on click, and clears on a second click or on empty floor', () => {
    const [x, y] = centre(l.cubicles[1]);
    assert.equal(clickFilter(l, cubicles, x, y, null), 'dots');
    assert.equal(clickFilter(l, cubicles, x, y, 'dots'), null);
    const w = workerRect(cubicleDesk(l.cubicles[1]));
    assert.equal(clickFilter(l, cubicles, w.x + 1, w.y + 1, 'bot'), 'dots');
    const [ax, ay] = centre(l.rooms.annex.rect);
    assert.equal(clickFilter(l, cubicles, ax, ay, 'dots'), null);
  });
});

describe('fitting the scene to the screen', () => {
  it('uses whole-number scales on a wide screen, filling the width', () => {
    assert.deepEqual(fitScene(1248, 1000, 1), { mode: 'wide', width: 624, scale: 2 });
    assert.deepEqual(fitScene(1248, 1000, 2), { mode: 'wide', width: 624, scale: 4 });
    assert.deepEqual(fitScene(900, 1000, 1), { mode: 'wide', width: 720, scale: 1 });
  });

  it("doesn't grow taller than the screen", () => {
    assert.equal(fitScene(1800, 800, 1).scale, 2);
  });

  it('stacks the rooms on a narrow screen, never wider than it', () => {
    for (const [w, dpr] of [
      [358, 3],
      [320, 2],
      [390, 1],
      [300, 1],
    ]) {
      const f = fitScene(w, 800, dpr);
      assert.equal(f.mode, 'narrow');
      assert.ok((f.width * f.scale) / dpr <= w, `${w}@${dpr}: ${JSON.stringify(f)}`);
    }
  });
});
