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
 * @typedef {{ room: 'cubicle', alias: string } | { room: 'annex' | 'library' }} Place
 *   Where a worker sits: a workspace's cubicle, the Annex or the Library.
 *
 * @typedef {{
 *   runId: string,
 *   label: string | null,
 *   activity: string | null,
 *   place: Place,
 *   delivery: { by: 'envelope' | 'phone', at: number },
 *   work: 'typing' | 'reviewed' | 'scribbling',
 *   pile: number,
 *   bubble: string | null,
 *   postRun: boolean,
 * }} SceneRun
 *   The active run's worker. `delivery`: how the mail carrier brought it (an interoffice envelope
 *   for the cron, the phone ringing first for a manual run), and when, on the snapshot's clock.
 *   `work`: typing in the agent phase, sitting still for the boss's review in post-run, and
 *   scribbling in the autofix (an agent phase after post-run). `pile`: sheets of paper on the
 *   desk, 0 to PILE_MAX. `bubble`: the speech bubble, shortened. `activity`: the whole of it, for
 *   the hover tip. `postRun`: an issue run's post-run has been seen, so a later agent phase is the
 *   autofix. The snapshot can't tell the review from the commit and PR before it, so the whole of
 *   post-run counts as the review. A page opened mid-autofix can't tell it from the first pass.
 *
 * @typedef {{ at: Place | null, from: Place | null, since: number }} SceneBoss
 *   Where the boss is: `at` a worker's desk, or null for their own office. `from` and `since`:
 *   where they last walked from and when (0 when there's no walk to show).
 *
 * @typedef {'stamped' | 'folder' | 'injured' | 'asleep' | 'home' | 'dizzy' | 'shrug' | 'idle'} RestingState
 *   How a room's last run went: merged (a stamp, papers to the out tray), a PR left open (a folder
 *   on the boss's desk), failed (an injured worker), timed out (asleep at the desk), stopped (the
 *   worker gone home, the room dark), interrupted by a restart (a dizzy worker), no changes (a
 *   shrug and a tumbleweed). `idle`, the neutral fallback, shows nothing.
 *
 * @typedef {{
 *   place: Place,
 *   state: RestingState,
 *   quick: boolean,
 *   runId: string,
 *   label: string | null,
 *   outcome: string,
 *   endedAt: number,
 *   prUrl: string | null,
 * }} SceneOutcome
 *   A room's last run, shown there until the next run in it starts. `quick`: a short run, just a
 *   quick stamp. `outcome`: said in words, for the hover. `endedAt` on the snapshot's clock.
 *
 * @typedef {{
 *   dark: boolean,
 *   backInFive: boolean,
 *   cubicles: SceneCubicle[],
 *   reception: { countdownMs: number | null, letters: SceneLetter[] },
 *   run: SceneRun | null,
 *   boss: SceneBoss,
 *   outcomes: SceneOutcome[],
 * }} Scene
 *   `dark`: the runner is down. `backInFive`: the owner's general pause, as a sign on the front
 *   door. `countdownMs`: time to the next cron tick, null when there's no cron to count down to.
 *   `run`: the active run's worker, if any. `outcomes`: each room's last run, but the active run's
 *   room.
 *
 * @typedef {{ cubicles?: Array<{ alias: string, name?: string }> }} OfficeConfig
 *   `dashboard/office.json`: cubicle names and order, by workspace alias.
 */

/** @type {Scene} */
const EMPTY = { dark: false, backInFive: false, cubicles: [], reception: { countdownMs: null, letters: [] }, run: null, boss: { at: null, from: null, since: 0 }, outcomes: [] };

/** The most sheets a desk's pile holds. */
export const PILE_MAX = 16;
/** A sheet on the pile per this many turns, and per this much elapsed time. */
const TURNS_PER_SHEET = 5;
const MS_PER_SHEET = 3 * 60_000;
/** A run shorter than this gets just a quick stamp. */
const QUICK_MS = 5 * 60_000;
/** The speech bubble's longest text, before the view fits it to the room. */
const BUBBLE_CHARS = 48;

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

/** @param {Place | null} a @param {Place | null} b */
export const samePlace = (a, b) => a === b || (!!a && !!b && (a.room === 'cubicle' ? b.room === 'cubicle' && a.alias === b.alias : a.room === b.room));

/** `s` on one line, with the pixel font's characters, cut to `n`. @param {string | null} s @param {number} n */
function shorten(s, n) {
  if (!s) return null;
  const one = s.replace(/…/g, '...').replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 3).trimEnd()}...`;
}

/**
 * The room a run is worked in: its workspace's cubicle for an issue run, the Library for a Joplin
 * run, the Annex for freeform runs (and an issue run whose workspace has no cubicle). Null for a
 * scheduled job, whose rooms aren't in the office yet.
 * @param {{ kind: string | null, workspaceAlias: string | null }} r a run, in flight or finished
 * @param {SceneCubicle[]} cubicles
 * @returns {Place | null}
 */
function placeOf(r, cubicles) {
  if (r.kind === 'job') return null;
  if (r.kind === 'joplin') return { room: 'library' };
  if (r.kind === 'issue' && cubicles.some((c) => c.alias === r.workspaceAlias)) return { room: 'cubicle', alias: /** @type {string} */ (r.workspaceAlias) };
  return { room: 'annex' };
}

/** Each resting state, in words for the hover. @type {Record<RestingState, string>} */
const HOVER_WORDS = {
  stamped: 'merged',
  folder: 'PR open',
  injured: 'failed, needs a look',
  asleep: 'timed out',
  home: 'stopped',
  dizzy: 'interrupted by a restart',
  shrug: 'no changes',
  idle: '',
};

/**
 * How a finished run left its room. The agent's outcome says it first when it was cut short
 * (stopped, timed out, interrupted by a restart), since an issue run then records `failed`; then
 * an issue run's pipeline result. A run with no result (freeform, Joplin, a job) that succeeded
 * gets the stamp. Anything this page doesn't know is `idle`.
 * @param {Pick<import('../src/officeSnapshot.js').OfficeHistoryEntry, 'outcome' | 'result'>} h
 * @returns {RestingState}
 */
export function restingState({ outcome, result }) {
  if (outcome === 'interrupted') return 'dizzy';
  if (outcome === 'stopped') return 'home';
  if (outcome === 'timeout' || result === 'timeout') return 'asleep';
  if (outcome === 'failed' || outcome === 'spawn_error' || result === 'failed') return 'injured';
  if (outcome !== 'success') return 'idle';
  switch (result) {
    case null:
    case 'merged':
      return 'stamped';
    case 'pr_open':
    case 'pushed':
      return 'folder';
    case 'no_changes':
      return 'shrug';
    default:
      return 'idle';
  }
}

/**
 * Each room's last run (the history is newest first), but the room the active run is in: its
 * next run has started. Rooms no run has ended in (in the feed's 7 days) show nothing.
 * @param {import('../src/officeSnapshot.js').OfficeHistoryEntry[]} history
 * @param {SceneRun | null} run @param {SceneCubicle[]} cubicles
 * @returns {SceneOutcome[]}
 */
function reduceOutcomes(history, run, cubicles) {
  /** @type {SceneOutcome[]} */
  const out = [];
  for (const h of history) {
    const place = placeOf(h, cubicles);
    if (!place || out.some((o) => samePlace(o.place, place))) continue;
    const state = restingState(h);
    out.push({
      place,
      state,
      quick: h.durationMs != null && h.durationMs < QUICK_MS,
      runId: h.runId,
      label: h.label,
      outcome: HOVER_WORDS[state] || (h.result ? `${h.outcome} (${h.result})` : h.outcome),
      endedAt: Date.parse(h.endedAt),
      prUrl: h.prUrl ?? null,
    });
  }
  return out.filter((o) => !samePlace(o.place, run?.place ?? null));
}

/**
 * @param {import('../src/officeSnapshot.js').OfficeSnapshot} snap
 * @param {SceneRun | null} prev the worker before, if any
 * @param {SceneCubicle[]} cubicles @param {number} now
 * @returns {SceneRun | null}
 */
function reduceRun(snap, prev, cubicles, now) {
  const r = snap.activeRun;
  const place = r && placeOf(r, cubicles);
  if (!r || !place) return null;
  const same = prev?.runId === r.runId ? prev : null;
  // every agent run has a post-run, but only an issue run's has a review (and an autofix)
  const review = r.kind === 'issue' && r.phase === 'post-run';
  const postRun = review || !!same?.postRun;
  const work = review ? 'reviewed' : postRun ? 'scribbling' : 'typing';
  // the snapshot's own progress only: the feed's heartbeat resends it well within a sheet's time,
  // and counting on from a stale snapshot would grow the pile on every redraw
  const sheets = Math.min(PILE_MAX, Math.floor(r.turns / TURNS_PER_SHEET) + Math.floor((r.elapsedMs ?? 0) / MS_PER_SHEET));
  const started = r.startedAt ? Date.parse(r.startedAt) : NaN;
  return {
    runId: r.runId,
    label: r.label,
    activity: work === 'reviewed' ? null : r.lastActivity,
    place,
    delivery: same?.delivery ?? { by: r.trigger === 'manual' ? 'phone' : 'envelope', at: Number.isFinite(started) ? started : now },
    work,
    pile: Math.max(same?.pile ?? 0, sheets),
    bubble: work === 'reviewed' ? null : shorten(r.lastActivity, BUBBLE_CHARS),
    postRun,
  };
}

/**
 * The boss walks to the worker's desk once post-run starts, and stays through the autofix. When
 * the run ends, they walk back. A walk the page didn't see start (it opened mid-review) isn't shown.
 * @param {SceneRun | null} run @param {Scene | null} prev @param {number} now
 * @returns {SceneBoss}
 */
function reduceBoss(run, prev, now) {
  const was = prev?.boss ?? EMPTY.boss;
  const at = run?.postRun ? run.place : null;
  if (samePlace(was.at, at)) return was;
  return { at, from: was.at, since: prev?.run ? now : 0 };
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
  // from the snapshot, so pauses still run out while the runner is away.
  if (!up) {
    const lit = reduceScene(snap, prev, { up: true, now, config });
    return { ...lit, dark: true, reception: { ...lit.reception, countdownMs: null } };
  }
  const paused = new Set(snap.pauses.workspaces.filter((p) => holding(p, now)).map((p) => p.alias));
  const next = snap.cron?.alive && snap.cron.nextTickAt ? Date.parse(snap.cron.nextTickAt) : NaN;
  const cubicles = cubicleOrder(snap.workspaces, config).map((c) => ({ ...c, doNotDisturb: paused.has(c.alias) }));
  const run = reduceRun(snap, prev?.run ?? null, cubicles, now);
  return {
    dark: false,
    backInFive: holding(snap.pauses.general, now),
    cubicles,
    reception: {
      countdownMs: Number.isFinite(next) ? Math.max(0, next - now) : null,
      letters: snap.queue.map((q) => ({ id: q.id, label: q.label })),
    },
    run,
    boss: reduceBoss(run, prev, now),
    outcomes: reduceOutcomes(snap.history, run, cubicles),
  };
}
