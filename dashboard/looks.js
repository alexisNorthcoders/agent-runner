// Who looks like what: every worker in the office gets a look of their own (skin, hair colour and
// style, shirt, tie, glasses or a beard), steady across reloads and the same on every page. A
// workspace's resident and the worker on its runs are the same person, so they share a look, as
// do each scheduled job's worker across its runs, and the Freeform and Joplin rooms' own workers.
// No DOM here, so it can be tested in Node; sprites.js draws a look.
import { roll } from './ambient.js';

/**
 * @typedef {'short' | 'long' | 'buzz' | 'bun' | 'curly' | 'bald'} HairStyle
 * @typedef {{ skin: string, hair: string, style: HairStyle, shirt: string, tie: string | null, glasses: boolean, beard: boolean }} Look
 * @typedef {import('./scene.js').Place} Place
 */

export const SKINS = ['#f1c9a5', '#e3b98f', '#d2a073', '#a8714a', '#7a4e32', '#5a3a26'];
export const HAIRS = ['#2b1d14', '#4a3222', '#7a4a26', '#c9a24a', '#b0522f', '#9a9a9a', '#1d1d22'];
export const STYLES = /** @type {HairStyle[]} */ (['short', 'long', 'buzz', 'bun', 'curly', 'bald']);
export const SHIRTS = ['#e8e2d0', '#a9c7e8', '#e8b4b4', '#b8d8a8', '#f2e2a0', '#c7b8e0', '#6f93c4', '#d98a4a', '#8fa0ad', '#e0e0e0'];
const TIES = ['#8a2f3a', '#2f4a8a', '#2f6a3f', '#1d1d22'];

/** The look before anyone has one: the office's original worker. @type {Look} */
export const PLAIN = { skin: '#e3b98f', hair: '#4a3222', style: 'short', shirt: '#e8e2d0', tie: '#8a2f3a', glasses: false, beard: false };

/** How many shirt × hair-colour combinations there are to go round: the two that show most. */
const COMBOS = SHIRTS.length * HAIRS.length;

/**
 * The look at combination `i` (its shirt and hair colour), with the rest rolled from `key`.
 * @param {number} i @param {string} key @returns {Look}
 */
function lookAt(i, key) {
  const shirt = SHIRTS[i % SHIRTS.length];
  const hair = HAIRS[Math.floor(i / SHIRTS.length)];
  const style = STYLES[Math.floor(roll(key, 'style') * STYLES.length)];
  const extra = roll(key, 'extra');
  return {
    skin: SKINS[Math.floor(roll(key, 'skin') * SKINS.length)],
    hair,
    style,
    shirt,
    tie: roll(key, 'tie') < 0.55 ? TIES[Math.floor(roll(key, 'tie colour') * TIES.length)] : null,
    glasses: extra < 0.3,
    // no beard on a bun or long hair: it'd read as hair round the face at this size
    beard: extra >= 0.3 && extra < 0.5 && style !== 'bun' && style !== 'long',
  };
}

/**
 * A look for each worker key: a shirt and hair colour combination of its own (rolled from the key,
 * the next free one along if it's taken), so no two in the office match in both, and the rest
 * (skin, hair style, tie, glasses or beard) rolled from the key. Keys
 * are taken in order, so a worker joining doesn't change anyone's look unless they'd have clashed.
 * @param {string[]} keys
 * @returns {Map<string, Look>}
 */
export function looksFor(keys) {
  const taken = new Set();
  /** @type {Map<string, Look>} */
  const looks = new Map();
  for (const key of [...new Set(keys)].sort()) {
    let i = Math.floor(roll(key, 'look') * COMBOS);
    while (taken.has(i) && taken.size < COMBOS) i = (i + 1) % COMBOS;
    taken.add(i);
    looks.set(key, lookAt(i, key));
  }
  return looks;
}

/**
 * Whose look a place's worker wears: the workspace's resident at its own desk, the job's worker at
 * a job's desk, else the room's own worker.
 * @param {Place} p
 */
export const lookKey = (p) => (p.session ? `session:${p.session}` : p.room === 'cubicle' ? (p.job ? `job:${p.job}` : `ws:${p.alias}`) : `room:${p.room}`);

/**
 * Everyone who can be on the floor in an office with `cubicles`: each workspace's resident, each
 * job's worker, the Freeform and Joplin rooms' own workers, and the temps (`temp:<slot>`) who help
 * with subagents when no resident can, and each visitor (`session:<id>`): the owner at an
 * interactive session.
 * @param {Array<{ alias: string, workspace?: boolean, jobs: Array<{ name: string }> }>} cubicles
 * @param {Array<{ id: string }>} [sessions]
 */
export const workerKeys = (cubicles, sessions = []) => [
  ...sessions.map((s) => `session:${s.id}`),
  ...cubicles.flatMap((c) => [...(c.workspace === false ? [] : [`ws:${c.alias}`]), ...c.jobs.map((j) => `job:${j.name}`)]),
  'room:freeform',
  'room:joplin',
  ...Array.from({ length: TEMPS }, (_, i) => `temp:${i}`),
];

/** How many temps the Queue room can send to help with subagents, one per helper slot. */
export const TEMPS = 4;
