// The office scene reducer: what the office floor shows, from the office feed's snapshot and the
// scene before it. It holds the metaphor's rules, so the canvas (officeView.js) only draws. No
// DOM here, so it can be tested in Node.

/**
 * @typedef {{ number: number, title: string, blocked: boolean }} SceneTrayLetter
 *   A `ready-for-agent` issue waiting in a cubicle's in-tray; a `blocked` one has a padlock.
 *
 * @typedef {'janitor' | 'analyst' | 'clerk'} JobWorker
 *   A scheduled job's worker: a janitor with a mop (cleanup), an analyst with a chart easel
 *   (insight, report), or a generic clerk.
 *
 * @typedef {{ name: string, worker: JobWorker, at: string, nextDueAt: number | null }} SceneJobDesk
 *   A scheduled job's desk in its room, with its worker. `at`: its daily time (UTC); `nextDueAt`
 *   on the snapshot's clock.
 *
 * @typedef {{
 *   alias: string,
 *   name: string,
 *   workspace: boolean,
 *   doNotDisturb: boolean,
 *   inTray: SceneTrayLetter[],
 *   sticky: Array<{ number: number, title: string }>,
 *   jobs: SceneJobDesk[],
 *   quiet: boolean,
 *   sessions?: string[],
 * }} SceneCubicle
 *   One per allowlisted workspace (`workspace`), then one per scheduled-job room that isn't one
 *   (named and keyed by its room label), then a scripts room per room with clerk jobs (`<name>
 *   scripts`, keyed `<alias>#scripts`). `name` is its department sign. `inTray`: its repo's runnable
 *   issues, then its blocked ones, but the one being worked at its desk. `sticky`: its
 *   `ready-for-human` issues, a sticky note on the cubicle while there are any. `jobs`: the
 *   scheduled jobs whose room it is, in config order, each at its own desk after the workspace's
 *   (a clerk's job in its room's scripts room). `sessions`: the ids of the visitors at their own
 *   desks after those, oldest first. `quiet`: a workspace with no run started in the
 *   last QUIET_MS, so its resident dozes off more.
 *
 * @typedef {{ alias: string, number: number, title: string, prUrl: string }} SceneParked
 *   An open agent PR the cron has parked: a folder on the boss's desk.
 *
 * @typedef {{ id: string, at: number, drops: Array<{ alias: string, numbers: number[] }> }} SceneMail
 *   A round of mail: the in-tray letters (issue numbers) that turned up in the issue scan at `at`
 *   on the snapshot's clock, by cubicle, in the scene's order. Each is hidden from its tray until
 *   the mail carrier drops it there (walkers.js).
 *
 * @typedef {{
 *   id: string,
 *   description: string,
 *   activity: string | null,
 *   slot: number,
 *   place: Place,
 *   since: number,
 *   until: number | null,
 * }} SceneHelper
 *   One of the active run's subagents, played by a colleague called over to the run's desk at
 *   `place`: what it was asked to do and is doing now, its `slot` at the desk (the lowest free
 *   when it started, kept while it walks back), called at `since` and done at `until` (null while
 *   it runs), on the snapshot's clock. Those already helping when the page opened are already there
 *   (`since` 0).
 *
 * @typedef {{ id: string, label: string }} SceneLetter
 *   A queued request, as a letter on the mail cart.
 *
 * @typedef {{ room: 'cubicle', alias: string, job?: string, session?: string } | { room: 'freeform' | 'joplin', session?: string }} Place
 *   Where a worker sits: a cubicle (at the desk of its scheduled job `job`, else the workspace's
 *   own), the Freeform room or the Joplin room. A visitor (`session`: an interactive session's id)
 *   sits at their own laptop spot in a cubicle or the Freeform room.
 *
 * @typedef {{
 *   id: string,
 *   place: Place,
 *   repo: string,
 *   branch: string | null,
 *   state: 'working' | 'waiting',
 *   activity: string | null,
 *   tool: string | null,
 *   subagents: number,
 *   since: number,
 * }} SceneSession
 *   An open interactive session (the owner working with the agent), a visitor at a laptop in its
 *   workspace's cubicle, or in the Freeform room when it's in none. `repo`: its workspace's alias,
 *   else the folder it's in. `tool`: what the current tool is called on the tag (`Bash`, `Read`,
 *   `write`), null while waiting. `since` on the snapshot's clock.
 *
 * @typedef {{
 *   runId: string,
 *   label: string | null,
 *   activity: string | null,
 *   place: Place,
 *   worker: JobWorker | null,
 *   delivery: { by: 'envelope' | 'phone', at: number },
 *   work: 'typing' | 'reviewed' | 'scribbling',
 *   pile: number,
 *   bubble: string | null,
 *   postRun: boolean,
 *   moved: { from: Place, since: number } | null,
 * }} SceneRun
 *   The active run's worker. `worker`: a scheduled job's kind of worker, null for an agent run.
 *   A job has no turns, so its pile grows with elapsed time alone, and its bubble is the latest
 *   line of its output (from the live log). `delivery`: how the mail carrier brought it (an interoffice envelope
 *   for the cron, the phone ringing first for a manual run), and when, on the snapshot's clock.
 *   `work`: typing in the agent phase, sitting still for the boss's review in post-run, and
 *   scribbling in the autofix (an agent phase after post-run). `pile`: sheets of paper on the
 *   desk, 0 to PILE_MAX. `bubble`: the speech bubble, shortened. `activity`: the whole of it, for
 *   the hover tip. `postRun`: an issue run's post-run has been seen, so a later agent phase is the
 *   autofix. The snapshot can't tell the review from the commit and PR before it, so the whole of
 *   post-run counts as the review. A page opened mid-autofix can't tell it from the first pass.
 *   `moved`: the worker picked up their papers and walked here from `from` (a freeform run leaving
 *   the Freeform room for the cubicle it turned out to work in), at `since` on the snapshot's clock. Null
 *   when they haven't moved, or the page opened after they did.
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
 *   recorded: string,
 *   endedAt: number,
 *   prUrl: string | null,
 * }} SceneOutcome
 *   A room's last run, shown there until the next run in it starts. `quick`: a short run, just a
 *   quick stamp. `outcome`: said in words, for the hover. `recorded`: the history row's own
 *   outcome and result (`success, pushed`), so the hover can tell apart rows that share a state. `endedAt` on the snapshot's clock.
 *
 * @typedef {{
 *   dark: boolean,
 *   backInFive: boolean,
 *   cubicles: SceneCubicle[],
 *   queueRoom: { countdownMs: number | null, letters: SceneLetter[] },
 *   run: SceneRun | null,
 *   boss: SceneBoss,
 *   outcomes: SceneOutcome[],
 *   parked: SceneParked[],
 *   mail: SceneMail[],
 *   trayKnown: Record<string, number[]> | null,
 *   helpers: SceneHelper[],
 *   sessions?: SceneSession[],
 * }} Scene
 *   `dark`: the runner is down. `backInFive`: the owner's general pause, as a sign on the front
 *   door. `countdownMs`: time to the next cron tick, null when there's no cron to count down to.
 *   `run`: the active run's worker, if any. `outcomes`: each room's last run, but the active run's
 *   room. `parked`: the parked PRs of the workspaces with a cubicle. Pending issues come from the
 *   feed's issue scan, stale or not, and are empty before its first scan. `mail`: the rounds of new
 *   in-tray letters for the mail carrier to hand out, newest last, for MAIL_KEEP_MS. `trayKnown`:
 *   each cubicle's letters seen so far (null before the first scan), so only a new one is mail.
 *   `helpers`: the active run's subagents, each a colleague called over to its desk, and for
 *   HELPER_KEEP_MS after they're done, while they walk back. `sessions`: the open interactive
 *   sessions, oldest first.
 *
 * @typedef {{ cubicles?: Array<{ alias: string, name?: string }> }} OfficeConfig
 *   `dashboard/office.json`: cubicle names and order, by workspace alias.
 */

/** @type {Scene} */
const EMPTY = { dark: false, backInFive: false, cubicles: [], queueRoom: { countdownMs: null, letters: [] }, run: null, boss: { at: null, from: null, since: 0 }, outcomes: [], parked: [], mail: [], trayKnown: null, helpers: [], sessions: [] };

/** The most sheets a desk's pile holds. */
export const PILE_MAX = 16;
/** A sheet on the pile per this many turns, and per this much elapsed time. */
const TURNS_PER_SHEET = 5;
const MS_PER_SHEET = 3 * 60_000;
/** A run shorter than this gets just a quick stamp. */
const QUICK_MS = 5 * 60_000;
/** A workspace with no run started in this long is quiet. */
export const QUIET_MS = 3 * 24 * 3_600_000;
/** A done subagent's colleague stays in the scene this long, for their walk back. */
export const HELPER_KEEP_MS = 2 * 60_000;
/** A round of mail stays in the scene this long, long after it's handed out. */
export const MAIL_KEEP_MS = 10 * 60_000;
/** The speech bubble's longest text, before the view fits it to the room. */
const BUBBLE_CHARS = 48;

/**
 * A scheduled job's worker, from its name.
 * @param {string} name @returns {JobWorker}
 */
export function jobWorker(name) {
  const n = name.toLowerCase();
  if (n.includes('cleanup')) return 'janitor';
  if (n.includes('insight') || n.includes('report')) return 'analyst';
  return 'clerk';
}

/** A scripts room's alias: its room's, with this after it. */
const SCRIPTS_SUFFIX = '#scripts';

/**
 * The cubicles: the workspaces' (see cubicleOrder), then a room per scheduled-job room label that
 * isn't one of theirs, in config order, then the scripts rooms. A label matching a workspace's alias
 * or department sign is that workspace's cubicle. Each gets its jobs' desks, but a clerk's job (a
 * plain script, not an agent) sits in its room's scripts room (`<room> scripts`) instead.
 * @param {Array<{ alias: string, name: string }>} workspaces
 * @param {unknown} jobs the snapshot's job schedule
 * @returns {Array<{ alias: string, name: string, workspace: boolean, jobs: SceneJobDesk[] }>}
 */
function withJobRooms(workspaces, jobs) {
  const rooms = workspaces.map((c) => ({ ...c, workspace: true, jobs: /** @type {SceneJobDesk[]} */ ([]) }));
  /** @type {typeof rooms} */
  const scriptRooms = [];
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (typeof j?.name !== 'string' || typeof j.room !== 'string') continue;
    const worker = jobWorker(j.name);
    let room = rooms.find((c) => c.alias === j.room || c.name === j.room);
    if (!room) rooms.push((room = { alias: j.room, name: j.room, workspace: false, jobs: [] }));
    if (worker === 'clerk') {
      const alias = `${room.alias}${SCRIPTS_SUFFIX}`;
      const home = room;
      room = scriptRooms.find((c) => c.alias === alias);
      if (!room) scriptRooms.push((room = { alias, name: `${home.name} scripts`, workspace: false, jobs: [] }));
    }
    const due = typeof j.nextDueAt === 'string' ? Date.parse(j.nextDueAt) : NaN;
    room.jobs.push({ name: j.name, worker, at: typeof j.at === 'string' ? j.at : '', nextDueAt: Number.isFinite(due) ? due : null });
  }
  // A job room left with only scripts has no desks of its own.
  return [...rooms.filter((c) => c.workspace || c.jobs.length), ...scriptRooms];
}

/** The last line of `lines` with anything on it. @param {string[]} lines */
export const lastLine = (lines) => [...lines].reverse().find((l) => l.trim()) ?? null;

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

/** Whether `a` and `b` are the same room (a cubicle's job desks are all in it). @param {Place | null} a @param {Place | null} b */
export const samePlace = (a, b) => a === b || (!!a && !!b && (a.room === 'cubicle' ? b.room === 'cubicle' && a.alias === b.alias : a.room === b.room));

/** `s` on one line, with the pixel font's characters, cut to `n`. @param {string | null} s @param {number} n */
function shorten(s, n) {
  if (!s) return null;
  const one = s.replace(/…/g, '...').replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 3).trimEnd()}...`;
}

/**
 * The room a run is worked in: its workspace's cubicle for an issue run, and for a freeform run
 * once its workspace is inferred, its job's desk in its room for a scheduled job, the Joplin room for
 * a Joplin run, else the Freeform room (a freeform run that hasn't found a workspace, or any run whose
 * workspace or job has no cubicle).
 * @param {{ kind: string | null, workspaceAlias: string | null, inferredWorkspace?: string | null, jobName?: string | null }} r
 *   a run, in flight or finished
 * @param {SceneCubicle[]} cubicles
 * @returns {Place}
 */
function placeOf(r, cubicles) {
  if (r.kind === 'job') {
    const job = r.jobName;
    const c = job ? cubicles.find((x) => x.jobs.some((j) => j.name === job)) : null;
    return c && job ? { room: 'cubicle', alias: c.alias, job } : { room: 'freeform' };
  }
  if (r.kind === 'joplin') return { room: 'joplin' };
  const alias = r.kind === 'issue' ? r.workspaceAlias : r.kind === 'freeform' ? r.inferredWorkspace : null;
  if (alias && cubicles.some((c) => c.alias === alias)) return { room: 'cubicle', alias };
  return { room: 'freeform' };
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
 * (stopped, timed out or out of usage, interrupted by a restart), since an issue run may then record `failed`; then
 * an issue run's pipeline result. A run with no result (freeform, Joplin, a job) that succeeded
 * gets the stamp. Anything this page doesn't know is `idle`.
 * @param {Pick<import('../src/officeSnapshot.js').OfficeHistoryEntry, 'outcome' | 'result'>} h
 * @returns {RestingState}
 */
export function restingState({ outcome, result }) {
  if (outcome === 'interrupted') return 'dizzy';
  if (outcome === 'stopped') return 'home';
  if (outcome === 'timeout' || outcome === 'limited' || result === 'timeout' || result === 'limited') return 'asleep';
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
    if (out.some((o) => samePlace(o.place, place))) continue;
    const state = restingState(h);
    const recorded = h.result ? `${h.outcome}, ${h.result}` : h.outcome;
    out.push({
      place,
      state,
      quick: h.durationMs != null && h.durationMs < QUICK_MS,
      runId: h.runId,
      label: h.label,
      outcome: HOVER_WORDS[state] || recorded,
      recorded,
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
 * @param {{ runId: string | null, lines: string[] } | undefined} log the live log the page holds
 * @returns {SceneRun | null}
 */
function reduceRun(snap, prev, cubicles, now, log) {
  const r = snap.activeRun;
  if (!r) return null;
  const place = placeOf(r, cubicles);
  const same = prev?.runId === r.runId ? prev : null;
  // every agent run has a post-run, but only an issue run's has a review (and an autofix)
  const review = r.kind === 'issue' && r.phase === 'post-run';
  const postRun = review || !!same?.postRun;
  const work = review ? 'reviewed' : postRun ? 'scribbling' : 'typing';
  const isJob = r.kind === 'job';
  // a job's activity is its output, which only the live log carries
  const activity = isJob ? (log?.runId === r.runId ? lastLine(log.lines) : null) : r.lastActivity;
  // the snapshot's own progress only: the feed's heartbeat resends it well within a sheet's time,
  // and counting on from a stale snapshot would grow the pile on every redraw
  const sheets = Math.min(PILE_MAX, Math.floor(r.turns / TURNS_PER_SHEET) + Math.floor((r.elapsedMs ?? 0) / MS_PER_SHEET));
  const started = r.startedAt ? Date.parse(r.startedAt) : NaN;
  return {
    runId: r.runId,
    label: r.label,
    activity: work === 'reviewed' ? null : activity,
    place,
    worker: isJob ? jobWorker(r.jobName ?? '') : null,
    delivery: same?.delivery ?? { by: r.trigger === 'manual' ? 'phone' : 'envelope', at: Number.isFinite(started) ? started : now },
    work,
    pile: Math.max(same?.pile ?? 0, sheets),
    bubble: work === 'reviewed' ? null : shorten(activity, BUBBLE_CHARS),
    postRun,
    moved: same && !samePlace(same.place, place) ? { from: same.place, since: now } : (same?.moved ?? null),
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
 * @param {{ up: boolean, now: number, config?: unknown, log?: { runId: string | null, lines: string[] } }} o
 *   `now` on the snapshot's clock. `log`: the active run's live log as the page holds it (a
 *   scheduled job's bubble is its latest line).
 * @returns {Scene}
 */
export function reduceScene(snap, prev, { up, now, config, log }) {
  if (!snap) return { ...(prev ?? EMPTY), dark: !up, queueRoom: { ...(prev ?? EMPTY).queueRoom, countdownMs: null } };
  // down: the floor as the last snapshot saw it, with the lights off and nothing ticking. Built
  // from the snapshot, so pauses still run out while the runner is away.
  if (!up) {
    const lit = reduceScene(snap, prev, { up: true, now, config, log });
    return { ...lit, dark: true, queueRoom: { ...lit.queueRoom, countdownMs: null } };
  }
  const paused = new Set(snap.pauses.workspaces.filter((p) => holding(p, now)).map((p) => p.alias));
  const next = snap.cron?.alive && snap.cron.nextTickAt ? Date.parse(snap.cron.nextTickAt) : NaN;
  const repos = new Map((snap.issues?.repos ?? []).map((r) => [r.alias, r]));
  const r = snap.activeRun;
  const working = r?.kind === 'issue' ? { alias: r.workspaceAlias, number: r.issueNumber } : null;
  /** The workspaces with a run started in the last QUIET_MS, or running now. */
  const busy = new Set(
    [...snap.history, ...(r ? [r] : [])]
      .filter((h) => !(now - Date.parse(h.startedAt) > QUIET_MS))
      .map((h) => (h.kind === 'issue' ? h.workspaceAlias : h.kind === 'freeform' ? h.inferredWorkspace : null))
  );
  const cubicles = withJobRooms(cubicleOrder(snap.workspaces, config), snap.jobs).map((c) => {
    const repo = repos.get(c.alias);
    /** @param {{ number: number, title: string }} i @param {boolean} blocked */
    const letter = (i, blocked) => ({ number: i.number, title: i.title, blocked });
    return {
      ...c,
      doNotDisturb: paused.has(c.alias),
      inTray: [...(repo?.runnable ?? []).map((i) => letter(i, false)), ...(repo?.blocked ?? []).map((i) => letter(i, true))].filter(
        (l) => !(working?.alias === c.alias && working.number === l.number)
      ),
      sticky: (repo?.readyForHuman ?? []).map((i) => ({ number: i.number, title: i.title })),
      quiet: c.workspace && !busy.has(c.alias),
      sessions: /** @type {string[]} */ ([]),
    };
  });
  const sessions = reduceSessions(snap, cubicles);
  const run = reduceRun(snap, prev?.run ?? null, cubicles, now, log);
  return {
    dark: false,
    backInFive: holding(snap.pauses.general, now),
    cubicles,
    queueRoom: {
      countdownMs: Number.isFinite(next) ? Math.max(0, next - now) : null,
      letters: snap.queue.map((q) => ({ id: q.id, label: q.label })),
    },
    run,
    boss: reduceBoss(run, prev, now),
    outcomes: reduceOutcomes(snap.history, run, cubicles),
    parked: cubicles.flatMap((c) => (repos.get(c.alias)?.parked ?? []).map((p) => ({ alias: c.alias, number: p.number, title: p.title, prUrl: p.prUrl }))),
    ...reduceMail(!!snap.issues, prev, cubicles, working, now),
    helpers: reduceHelpers(prev, run, r, now),
    sessions,
  };
}

/** The tool a session's activity names (`Bash: git diff` → `Bash`), or `write` while it's writing. @param {string | null} activity */
export const toolOf = (activity) => (!activity ? null : activity.startsWith('writing') ? 'write' : activity.split(':')[0].trim());

/**
 * The visitors: one per open interactive session, oldest first, each in its workspace's cubicle
 * (whose `sessions` this fills in) or, in none, the Freeform room.
 * @param {import('../src/officeSnapshot.js').OfficeSnapshot} snap @param {SceneCubicle[]} cubicles
 * @returns {SceneSession[]}
 */
function reduceSessions(snap, cubicles) {
  /** @type {SceneSession[]} */
  const out = [];
  for (const s of Array.isArray(snap.sessions) ? snap.sessions : []) {
    if (typeof s?.id !== 'string' || (s.state !== 'working' && s.state !== 'waiting')) continue;
    const c = s.workspaceAlias ? cubicles.find((x) => x.workspace && x.alias === s.workspaceAlias) : null;
    if (c) (c.sessions ??= []).push(s.id);
    const since = Date.parse(s.since);
    out.push({
      id: s.id,
      place: c ? { room: 'cubicle', alias: c.alias, session: s.id } : { room: 'freeform', session: s.id },
      repo: s.workspaceAlias ?? (String(s.cwd ?? '').split('/').filter(Boolean).pop() || 'session'),
      branch: s.branch ?? null,
      state: s.state,
      activity: s.activity ?? null,
      tool: s.state === 'working' ? (toolOf(s.activity ?? null) ?? 'write') : null,
      subagents: Number.isFinite(s.subagents) ? s.subagents : 0,
      since: Number.isFinite(since) ? since : 0,
    });
  }
  return out;
}

/**
 * The colleagues helping the active run, one per subagent it has running: a new one called over
 * at `now` (already there when the page has just opened), a done one walking back for HELPER_KEEP_MS.
 * @param {Scene | null} prev @param {SceneRun | null} run the scene's
 * @param {{ phase?: string | null, subagents?: Array<{ id: string, description: string, activity: string | null }> } | null} r the snapshot's active run
 * @param {number} now
 * @returns {SceneHelper[]}
 */
function reduceHelpers(prev, run, r, now) {
  const live = run && r && r.phase !== 'post-run' && Array.isArray(r.subagents) ? r.subagents : [];
  /** @type {SceneHelper[]} */
  const helpers = [];
  for (const h of prev?.helpers ?? []) {
    if (h.until != null) {
      if (now - h.until < HELPER_KEEP_MS) helpers.push(h);
      continue;
    }
    const a = live.find((x) => x.id === h.id);
    helpers.push(a ? { ...h, description: a.description, activity: a.activity } : { ...h, until: now });
  }
  for (const a of live) {
    if (!run || helpers.some((h) => h.id === a.id)) continue;
    let slot = 0;
    while (helpers.some((h) => h.slot === slot)) slot++;
    helpers.push({ id: a.id, description: a.description, activity: a.activity, slot, place: run.place, since: prev ? now : 0, until: null });
  }
  return helpers;
}

/**
 * The mail: a new round when in-tray letters turn up that the scene hasn't seen in that cubicle
 * before (not one coming back from the desk, nor any the page found there when it opened or saw
 * the first scan), and the rounds of the last MAIL_KEEP_MS.
 * @param {boolean} scanned the snapshot has the issue scan
 * @param {Scene | null} prev
 * @param {SceneCubicle[]} cubicles
 * @param {{ alias: string | null, number: number | null } | null} working the issue at a desk
 * @param {number} now
 * @returns {{ mail: SceneMail[], trayKnown: Record<string, number[]> | null }}
 */
function reduceMail(scanned, prev, cubicles, working, now) {
  const kept = (prev?.mail ?? []).filter((m) => now - m.at < MAIL_KEEP_MS);
  if (!scanned) return { mail: kept, trayKnown: prev?.trayKnown ?? null };
  const known = prev?.trayKnown ?? null;
  /** @type {Record<string, number[]>} */
  const next = { ...(known ?? {}) };
  /** @type {SceneMail['drops']} */
  const drops = [];
  for (const c of cubicles) {
    const here = [...c.inTray.map((l) => l.number), ...(working?.alias === c.alias && working.number != null ? [working.number] : [])];
    const seen = new Set(known?.[c.alias] ?? []);
    const fresh = c.inTray.map((l) => l.number).filter((n) => !seen.has(n));
    if (known && fresh.length) drops.push({ alias: c.alias, numbers: fresh });
    next[c.alias] = [...new Set([...seen, ...here])];
  }
  return { mail: drops.length ? [...kept, { id: `mail-${now}`, at: now, drops }] : kept, trayKnown: next };
}
