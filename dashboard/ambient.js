// The office's ambient life: who is in when nobody is running anything, and what they get up to.
// Each workspace's resident sits at its desk through the day, fidgeting (a sip of coffee, a
// stretch), and now and then takes a break: to the water cooler, the Joplin room's bookshelf, or a
// neighbour's cubicle for a chat. They react to what's really going on (peering at the cubicle where
// a run is being worked, flicking through their in-tray, clapping a merge next door) and go home at
// night, when a janitor mops the aisles. None of it types, piles up papers or says anything in a
// bubble: that stays the active run's, so a real run still stands out. Everything here is a pure
// function of the scene and the time, so every page draws the same office. No DOM here, so it can
// be tested in Node; walkers.js routes the breaks and the janitor, and officeView.js draws them.
import { samePlace } from './scene.js';

/** @typedef {import('./layout.js').Layout} Layout */
/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./scene.js').SceneCubicle} SceneCubicle */

/**
 * @typedef {'morning' | 'day' | 'evening' | 'night'} DayPart
 *   The time of day on the viewer's clock: it sets the sky in the windows, and at night the
 *   residents are home and the lights are down.
 * @typedef {'still' | 'sip' | 'stretch' | 'lean' | 'look' | 'doze' | 'sort' | 'peek' | 'cheer' | 'clap' | 'chat'} Pose
 *   A seated resident's idle pose. `sort`: flicking through their in-tray. `peek`: peering over at
 *   the cubicle next door where a run is being worked. `cheer`, `clap`: a merge in their cubicle,
 *   or next door. `chat`: talking to a visitor.
 * @typedef {{ kind: 'cooler' } | { kind: 'books' } | { kind: 'chat', alias: string }} BreakTo
 *   Where a break goes: the Freeform room's water cooler, the Joplin room's bookshelf, or a
 *   neighbour's cubicle.
 * @typedef {{ alias: string, to: BreakTo, start: number, walk: number, linger: number }} Break
 *   A resident's break: setting off from their desk at `start`, `walk` ms each way, `linger` ms there.
 */

/** Resting states with the room's worker drawn at the desk (or gone home), so no resident sits there. */
export const WORKER_STATES = new Set(['injured', 'asleep', 'dizzy', 'shrug', 'home']);
/** A resident's idle pose lasts this long before the next. */
export const POSE_MS = 5000;
/** How long the neighbours clap a merge. */
export const CLAP_MS = 8000;
/** Breaks: a chance of one every BREAK_EVERY_MS on each of BREAK_LANES lanes, so at most a couple at once. */
export const BREAK_EVERY_MS = 20_000;
const BREAK_LANES = 2;
const BREAK_CHANCE = 0.6;
/** How long a break lingers where it goes. */
export const LINGER_MS = 7000;
/** How far back a break can have started and still be under way (a walk each way and the linger). */
const BREAK_LOOKBACK = 3;

/** A steady number from `s`: FNV-1a, then mixed (murmur3's finaliser) so that strings a digit apart land far apart. @param {string} s */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** A steady 0..1 from its parts: the same for the same parts on every page. @param {...(string | number)} parts */
export const roll = (...parts) => hash(parts.join(':')) / 2 ** 32;

/**
 * The time of day at `t` on a clock `tzOffsetMin` minutes behind UTC (Date#getTimezoneOffset):
 * night 22:00–07:00, morning to 09:00, day to 18:00, then evening.
 * @param {number} t @param {number} tzOffsetMin
 * @returns {DayPart}
 */
export function dayPart(t, tzOffsetMin) {
  const minutes = (((Math.floor(t / 60_000) - tzOffsetMin) % 1440) + 1440) % 1440;
  const h = minutes / 60;
  if (h >= 22 || h < 7) return 'night';
  if (h < 9) return 'morning';
  if (h < 18) return 'day';
  return 'evening';
}

/**
 * The cubicles beside each one in its row of the layout, left then right (null where there's none).
 * @param {Layout} layout @param {Array<{ alias: string }>} cubicles the scene's, in the layout's order
 * @returns {Map<string, { left: string | null, right: string | null }>}
 */
export function neighbours(layout, cubicles) {
  /** @type {Map<string, { left: string | null, right: string | null }>} */
  const next = new Map();
  /** @param {number} i @param {number} j */
  const beside = (i, j) => {
    const [a, b] = [layout.cubicles[i], layout.cubicles[j]];
    return a && b && a.y === b.y ? cubicles[j].alias : null;
  };
  cubicles.forEach((c, i) => next.set(c.alias, { left: i > 0 ? beside(i, i - 1) : null, right: i < cubicles.length - 1 ? beside(i, i + 1) : null }));
  return next;
}

/**
 * The residents in at `t`, in the scene's order: one per workspace cubicle, all through the day
 * (none at night), but not while the active run's worker is on the floor for their cubicle (the
 * worker is them, at work), nor while the cubicle's last outcome has its worker at the desk or gone home.
 * @param {Scene} scene @param {DayPart} part
 * @param {boolean} runOnFloor the active run's worker is on the floor (seated, or moving desks)
 * @returns {string[]} their cubicles' aliases
 */
export function residentsIn(scene, part, runOnFloor) {
  if (scene.dark || part === 'night') return [];
  const run = scene.run;
  const working = runOnFloor && run?.place.room === 'cubicle' && !run.place.job ? run.place.alias : null;
  return scene.cubicles
    .filter((c) => c.workspace && c.alias !== working)
    .filter((c) => {
      const o = scene.outcomes.find((x) => samePlace(x.place, { room: 'cubicle', alias: c.alias }));
      return !(o && WORKER_STATES.has(o.state) && (o.state === 'home' || (o.place.room === 'cubicle' && !o.place.job)));
    })
    .map((c) => c.alias);
}

/**
 * The breaks under way at `t`. Each lane rolls for a break every BREAK_EVERY_MS (the lanes half a
 * period apart), picking a resident who's in and not on Do Not Disturb, and where they go; a break
 * that would share someone with an earlier one under way at the same time is skipped. Who's in is
 * taken at `t`, so a resident who leaves (a run arriving, nightfall) drops their break with them.
 * @param {Scene} scene @param {string[]} present residentsIn's
 * @param {number} t
 * @param {(alias: string, to: BreakTo) => number | null} walkMs how long the walk there takes, null when there's no way
 * @returns {Break[]}
 */
export function breaks(scene, present, t, walkMs) {
  const dnd = new Set(scene.cubicles.filter((c) => c.doNotDisturb).map((c) => c.alias));
  const free = present.filter((a) => !dnd.has(a));
  if (!free.length) return [];
  /** @type {Break[]} */
  const rolled = [];
  for (let lane = 0; lane < BREAK_LANES; lane++) {
    const offset = (lane * BREAK_EVERY_MS) / BREAK_LANES;
    const k = Math.floor((t - offset) / BREAK_EVERY_MS);
    for (let kk = k - BREAK_LOOKBACK; kk <= k; kk++) {
      if (roll('break', lane, kk) >= BREAK_CHANCE) continue;
      const alias = free[Math.floor(roll('who', lane, kk) * free.length)];
      const others = free.filter((a) => a !== alias);
      const d = roll('to', lane, kk);
      /** @type {BreakTo} */
      const to = d < 0.35 || (d >= 0.65 && !others.length) ? { kind: 'cooler' } : d < 0.65 ? { kind: 'books' } : { kind: 'chat', alias: others[Math.floor(roll('chat', lane, kk) * others.length)] };
      const walk = walkMs(alias, to);
      if (walk == null) continue;
      rolled.push({ alias, to, start: kk * BREAK_EVERY_MS + offset + Math.floor(roll('start', lane, kk) * 3000), walk, linger: LINGER_MS });
    }
  }
  /** @param {Break} b */
  const people = (b) => [b.alias, ...(b.to.kind === 'chat' ? [b.to.alias] : [])];
  /** @param {Break} b */
  const end = (b) => b.start + 2 * b.walk + b.linger;
  /** @type {Break[]} */
  const kept = [];
  for (const b of rolled.sort((x, y) => x.start - y.start)) {
    const clash = kept.some((a) => a.start < end(b) && b.start < end(a) && people(a).some((p) => people(b).includes(p)));
    if (!clash) kept.push(b);
  }
  return kept.filter((b) => b.start <= t && t < end(b));
}

/**
 * A seated resident's pose at `t`, held for POSE_MS: cheering a merge in their cubicle or clapping
 * one next door (for CLAP_MS after it), else now and then peering at a run being worked next door,
 * flicking through their in-tray while it has letters, or dozing (often, in a quiet cubicle), else
 * fidgeting at random.
 * @param {SceneCubicle} c @param {Scene} scene @param {number} t
 * @param {{ left: string | null, right: string | null }} beside the cubicles next door
 * @param {string | null} runAt the cubicle whose own desk the active run's worker sits at
 * @returns {{ pose: Pose, facing: 'left' | 'right' }}
 */
export function restingPose(c, scene, t, beside, runAt) {
  const merged = (/** @type {string | null} */ alias) =>
    !!alias && scene.outcomes.some((o) => o.state === 'stamped' && o.place.room === 'cubicle' && o.place.alias === alias && t >= o.endedAt && t - o.endedAt < CLAP_MS);
  if (merged(c.alias)) return { pose: 'cheer', facing: 'right' };
  if (merged(beside.left)) return { pose: 'clap', facing: 'left' };
  if (merged(beside.right)) return { pose: 'clap', facing: 'right' };
  // each resident's poses change at their own moments, not all at once
  const k = Math.floor((t + hash(c.alias) % POSE_MS) / POSE_MS);
  const r = roll(c.alias, k);
  const near = runAt && (beside.left === runAt ? 'left' : beside.right === runAt ? 'right' : null);
  if (near && r < 0.5) return { pose: 'peek', facing: near };
  if (c.inTray.length && r < 0.2) return { pose: 'sort', facing: 'right' };
  if (r < (c.quiet ? 0.45 : 0.04)) return { pose: 'doze', facing: 'right' };
  const f = roll(c.alias, k, 'fidget');
  /** @type {Array<[Pose, number]>} */
  const fidgets = [['still', 0.55], ['sip', 0.15], ['lean', 0.12], ['look', 0.1], ['stretch', 0.08]];
  let acc = 0;
  for (const [pose, w] of fidgets) {
    acc += w;
    if (f < acc) return { pose, facing: pose === 'look' ? 'left' : 'right' };
  }
  return { pose: 'still', facing: 'right' };
}
