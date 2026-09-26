// The office scene reducer: what the office floor shows, from the office feed's snapshot and the
// scene before it. It holds the metaphor's rules, so the canvas (officeView.js) only draws. No
// DOM here, so it can be tested in Node.

/**
 * @typedef {{ alias: string, name: string, doNotDisturb: boolean }} SceneCubicle
 *   One per allowlisted workspace. `name` is its department sign.
 *
 * @typedef {{ id: string, label: string }} SceneLetter
 *   A queued request, as a letter on the mail cart.
 *
 * @typedef {{
 *   dark: boolean,
 *   backInFive: boolean,
 *   cubicles: SceneCubicle[],
 *   reception: { countdownMs: number | null, letters: SceneLetter[] },
 * }} Scene
 *   `dark`: the runner is down. `backInFive`: the owner's general pause, as a sign on the front
 *   door. `countdownMs`: time to the next cron tick, null when there's no cron to count down to.
 *
 * @typedef {{ cubicles?: Array<{ alias: string, name?: string }> }} OfficeConfig
 *   `dashboard/office.json`: cubicle names and order, by workspace alias.
 */

/** @type {Scene} */
const EMPTY = { dark: false, backInFive: false, cubicles: [], reception: { countdownMs: null, letters: [] } };

/** A pause the snapshot lists, unless it has run out since. @param {{ until: string } | null | undefined} p @param {number} now */
const holding = (p, now) => !!p && !(Date.parse(p.until) <= now);

/**
 * The allowlisted aliases in the config's order (renamed), then the rest in the feed's order.
 * Config entries for aliases that aren't allowlisted are skipped.
 * @param {string[]} aliases @param {unknown} config
 * @returns {Array<{ alias: string, name: string }>}
 */
export function cubicleOrder(aliases, config) {
  const entries = Array.isArray(/** @type {any} */ (config)?.cubicles) ? /** @type {any} */ (config).cubicles : [];
  /** @type {Map<string, string>} */
  const named = new Map();
  for (const e of entries) {
    if (typeof e?.alias !== 'string' || !aliases.includes(e.alias) || named.has(e.alias)) continue;
    named.set(e.alias, typeof e.name === 'string' && e.name.trim() ? e.name.trim() : e.alias);
  }
  return [...[...named].map(([alias, name]) => ({ alias, name })), ...aliases.filter((a) => !named.has(a)).map((alias) => ({ alias, name: alias }))];
}

/**
 * @param {import('../src/officeSnapshot.js').OfficeSnapshot | null} snap the last snapshot, if any
 * @param {Scene | null} prev the scene before this one
 * @param {{ up: boolean, now: number, config?: unknown }} o `now` on the snapshot's clock
 * @returns {Scene}
 */
export function reduceScene(snap, prev, { up, now, config }) {
  if (!snap) return { ...(prev ?? EMPTY), dark: !up, reception: { ...(prev ?? EMPTY).reception, countdownMs: null } };
  // down: the floor as the last snapshot saw it, with the lights off and nothing ticking. Built
  // from the snapshot, not `prev`, so pauses still run out while the runner is away.
  if (!up) {
    const lit = reduceScene(snap, null, { up: true, now, config });
    return { ...lit, dark: true, reception: { ...lit.reception, countdownMs: null } };
  }
  const paused = new Set(snap.pauses.workspaces.filter((p) => holding(p, now)).map((p) => p.alias));
  const next = snap.cron?.alive && snap.cron.nextTickAt ? Date.parse(snap.cron.nextTickAt) : NaN;
  return {
    dark: false,
    backInFive: holding(snap.pauses.general, now),
    cubicles: cubicleOrder(snap.workspaces, config).map((c) => ({ ...c, doNotDisturb: paused.has(c.alias) })),
    reception: {
      countdownMs: Number.isFinite(next) ? Math.max(0, next - now) : null,
      letters: snap.queue.map((q) => ({ id: q.id, label: q.label })),
    },
  };
}
