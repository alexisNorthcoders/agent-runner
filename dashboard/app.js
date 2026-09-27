// The office dashboard: listens to the office feed (`feed`, next to this page), draws the office
// floor on a canvas, and renders the panel's Now, Issues, History and Office tabs as text and tables. No
// build step, no dependencies. The snapshot shape is `OfficeSnapshot` in src/officeSnapshot.js.
import { ago, describeCronOutcome, formatCost, formatDuration, formatTokens, formatTotals, remaining, shortModel, what } from './format.js';
import { cartSlots, clickFilter, deskAt, fitScene, folderSlots, inTraySlots, inside, layoutOffice, placeName, placeRect, stickyNote, workerRect } from './layout.js';
import { applyLogEvent } from './logPane.js';
import { drawOffice } from './officeView.js';
import { lastLine, reduceScene, samePlace } from './scene.js';
import { walkers } from './walkers.js';

const FEED_URL = 'feed';
const RECONNECT_MS = 3000;
// the feed resends the snapshot every 30s, so this much silence means the connection is dead
const SILENCE_MS = 75_000;
const TABS = ['now', 'issues', 'history', 'office'];
/** How often the floor is redrawn while something on it moves. */
const REDRAW_MS = 100;

/** @type {any} the last OfficeSnapshot */
let snap = null;
/** local time the snapshot arrived, to keep elapsed times ticking between snapshots */
let receivedAt = 0;
let up = false;
/** @type {EventSource | null} */
let source = null;
let reconnectTimer = 0;
let silenceTimer = 0;
/** the active run's live log (masked by the runner), and whether the pane scrolls with it */
let pane = { runId: null, lines: [] };
let following = true;
/** cubicle names and order (office.json) */
let config = {};
/** @type {import('./scene.js').Scene | null} */
let scene = null;
/** @type {import('./layout.js').Layout | null} */
let layout = null;
/** the workspace the panel is filtered to, picked by clicking its cubicle */
let filter = null;
/** where the pointer is over the scene, in CSS pixels relative to the canvas, for the hover tip */
let pointer = null;
const sceneCanvas = /** @type {HTMLCanvasElement} */ (document.getElementById('scene'));
/** the scene at its internal resolution, before it's scaled up */
const buffer = document.createElement('canvas');

// --- DOM helpers ---

/** @param {string} tag @param {Record<string, string> | null} [attrs] @param {...(Node | string | null | undefined | false)} kids */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

/** @param {string[]} headers @param {(string | Node)[][]} rows @param {string} empty */
function table(headers, rows, empty) {
  if (!rows.length) return h('p', { class: 'dim' }, empty);
  return h('table', null, h('thead', null, h('tr', null, ...headers.map((x) => h('th', null, x)))), h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c) => h('td', null, c))))));
}

/** @param {[string, string | Node][]} pairs */
const dl = (pairs) => h('dl', null, ...pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));

/**
 * The workspace a run worked in: an issue run's, or the one a freeform run was inferred to.
 * @param {{ workspaceAlias: string | null, inferredWorkspace?: string | null }} r
 */
const workspaceOf = (r) => r.workspaceAlias ?? r.inferredWorkspace ?? null;

/** The latest line of `runId`'s live log with anything on it, if the pane holds its log. @param {string} runId */
const lastLogLine = (runId) => (pane.runId === runId ? lastLine(pane.lines) : null);

/** When a scheduled job is next due, from `t`. @param {{ nextDueAt: string | number | null }} j @param {number} t */
function nextDue(j, t) {
  const at = typeof j.nextDueAt === 'string' ? Date.parse(j.nextDueAt) : j.nextDueAt;
  if (at == null || !Number.isFinite(at)) return '-';
  return at > t ? `in ~${formatDuration(at - t)} (${new Date(at).toLocaleString()})` : 'due now';
}

/** The snapshot's clock, advanced by the time since it arrived. */
const now = () => Date.parse(snap.at) + (Date.now() - receivedAt);

// --- tabs ---

/** The usage-limit pause's line while it holds, else null. @param {number} t */
function usageLimitLine(t) {
  const l = snap.pauses.limit;
  return l && Date.parse(l.resetsAt) > t ? l.message : null;
}

function renderNow() {
  const t = now();
  const out = [];
  const limited = usageLimitLine(t);
  if (limited) out.push(h('p', { class: 'stale' }, `Paused: ${limited}`));
  const run = snap.activeRun;
  const elapsed = run && formatDuration(run.elapsedMs == null ? null : run.elapsedMs + (Date.now() - receivedAt));
  if (!run) out.push(h('p', null, 'Agent: idle'));
  else if (run.kind === 'job') {
    // a job has no model, turns or tokens: its output is the live log below
    out.push(
      h('h2', null, what(run)),
      dl([
        ['trigger', run.trigger],
        ['room', run.room ?? '-'],
        ['elapsed', elapsed],
        ['output', lastLogLine(run.runId) ?? '-'],
        ['run', run.runId],
      ])
    );
  } else {
    out.push(
      h('h2', null, what(run)),
      dl([
        ['trigger', run.trigger],
        ['workspace', run.workspaceAlias ?? (run.inferredWorkspace ? `${run.inferredWorkspace} (inferred)` : '-')],
        ['issue', run.issueNumber != null ? `#${run.issueNumber}` : '-'],
        ['phase', run.phase ?? '-'],
        ['model', shortModel(run.model)],
        ['elapsed', elapsed],
        ['turns', String(run.turns)],
        ['tokens', `${formatTokens(run.outputTokens)} out · ${formatTokens(run.contextTokens)} ctx`],
        ['last activity', run.lastActivity ?? '-'],
        ['run', run.runId],
      ])
    );
  }
  const others = snap.active.filter((r) => r.runId !== run?.runId);
  if (others.length) {
    out.push(h('h3', null, 'Needs attention'));
    out.push(
      table(
        ['run', 'what', 'state', 'started'],
        others.map((r) => [r.runId, what(r), r.health, ago(r.startedAt, t)]),
        ''
      )
    );
  }
  out.push(h('h3', null, 'Queue'), table(['#', 'what', 'kind', 'waiting'], snap.queue.map((q, i) => [String(i + 1), q.label, q.kind, formatDuration(t - Date.parse(q.queuedAt))]), 'The queue is empty.'));
  out.push(h('p', null, `Today: ${formatTotals(snap.spend.today)}`));
  return out;
}

/** A note that the tab is filtered to a workspace, or nothing. */
function filterNote() {
  if (!filter) return null;
  const clear = h('a', { href: '#' }, 'show all');
  clear.addEventListener('click', (e) => {
    e.preventDefault();
    setFilter(null);
  });
  return h('p', { class: 'filter' }, `Showing ${filter} only (click its cubicle again or `, clear, ')');
}

function renderHistory() {
  const t = now();
  const rows = filter ? snap.history.filter((r) => workspaceOf(r) === filter) : snap.history;
  return [
    h('p', null, `Today: ${formatTotals(snap.spend.today)}`, h('br'), `7 days: ${formatTotals(snap.spend.week)}`),
    filterNote(),
    table(
      ['ended', 'kind', 'trigger', 'what', 'outcome', 'took', 'model', 'turns', 'total tok', 'cost'],
      rows.map((r) => [
        ago(r.endedAt, t),
        r.kind ?? '-',
        r.trigger,
        what(r),
        r.result ? `${r.outcome} (${r.result})` : r.outcome,
        formatDuration(r.durationMs),
        shortModel(r.model),
        String(r.turns),
        formatTokens(r.tokens),
        formatCost(r.costUsd),
      ]),
      filter ? `No finished runs in ${filter} in the last 7 days.` : 'No finished runs in the last 7 days.'
    ),
  ];
}

/** @param {{ number: number, title: string, url: string }} i @param {string} [extra] */
const issueLink = (i, extra) => h('li', null, h('a', { href: i.url, target: '_blank', rel: 'noopener' }, `#${i.number}`), ` ${i.title}`, extra ?? null);

/** @param {string} title @param {Node[]} items */
const issueList = (title, items) => (items.length ? [h('h4', null, `${title} (${items.length})`), h('ul', null, ...items)] : []);

function renderIssues() {
  const t = now();
  const scan = snap.issues;
  if (!scan) return [h('p', { class: 'dim' }, 'Not scanned yet: the runner scans GitHub on startup, on a timer and after each run.')];
  const repos = filter ? scan.repos.filter((r) => r.alias === filter) : scan.repos;
  return [
    h('p', null, `Scanned ${ago(scan.scannedAt, t)}.`),
    filterNote(),
    ...(repos.length ? [] : [h('p', { class: 'dim' }, filter ? `No scan of ${filter}.` : 'No allowlisted workspaces.')]),
    ...repos.flatMap((r) => {
      const when = r.scannedAt ? `scanned ${ago(r.scannedAt, t)}` : 'never scanned';
      const pr = (/** @type {{ prUrl: string }} */ p) => h('span', null, ' · ', h('a', { href: p.prUrl, target: '_blank', rel: 'noopener' }, 'PR'));
      const lists = [
        ...issueList('Ready for agent: runnable', r.runnable.map((i) => issueLink(i))),
        ...issueList('Ready for agent: blocked', r.blocked.map((i) => issueLink(i))),
        ...issueList('Ready for agent: parked', r.parked.map((i) => issueLink(i, pr(i)))),
        ...issueList('Ready for human', r.readyForHuman.map((i) => issueLink(i))),
      ];
      return [
        h('h3', null, r.alias, r.repo ? h('span', { class: 'dim' }, ` ${r.repo}`) : null),
        h('p', { class: r.stale ? 'stale' : 'dim' }, r.stale ? `stale: the last scan failed (data ${when})` : when, ` · needs-triage ${r.needsTriage} · needs-info ${r.needsInfo}`),
        ...(lists.length ? lists : [h('p', { class: 'dim' }, 'Nothing waiting.')]),
      ];
    }),
  ];
}

function renderOffice() {
  const t = now();
  const c = snap.cron;
  let cron = 'not started (no ticks recorded)';
  if (c) {
    const health = c.alive ? `every ${formatDuration(c.intervalMs)} · pid ${c.pid}` : `pid ${c.pid} NOT running`;
    const last = c.lastTickEndedAt ? `last tick ${ago(c.lastTickEndedAt, t)}: ${describeCronOutcome(c.outcome)}` : describeCronOutcome(null);
    const next = c.nextTickAt ? (Date.parse(c.nextTickAt) > t ? ` · next tick in ~${formatDuration(Date.parse(c.nextTickAt) - t)}` : ' · next tick due') : '';
    cron = `${health} · ${last}${next}`;
  }
  const p = snap.pauses;
  const restart = p.restart === 'unknown' ? 'unknown (Redis unreachable)' : p.restart ? `yes, ${p.restart.reason}${p.restart.pausedAt ? ` (${ago(p.restart.pausedAt, t)})` : ''}` : 'no';
  const general = p.general ? `everything for ${remaining(p.general.until, t)}${p.general.reason ? ` (${p.general.reason})` : ''}` : 'no';
  const lock = snap.lock ? `${snap.lock.runId} (${what(snap.lock)}), since ${ago(snap.lock.startedAt, t)}` : 'free';
  const paused = new Map(p.workspaces.map((w) => [w.alias, w]));
  return [
    dl([
      ['runner', up ? 'up' : 'down'],
      ['snapshot', `${new Date(snap.at).toLocaleTimeString()} (${ago(snap.at, t)})`],
      ['cron', cron],
      ['restart pause', restart],
      ['paused by hand', general],
      ['usage limit', usageLimitLine(t) ?? 'no'],
      ['lock', lock],
      ['queue', snap.queue.length ? `${snap.queue.length} waiting (next: ${snap.queue[0].label})` : 'empty'],
    ]),
    h('h3', null, 'Workspaces'),
    table(
      ['workspace', 'state'],
      snap.workspaces.map((alias) => {
        const wp = paused.get(alias);
        const busy = !!snap.activeRun && workspaceOf(snap.activeRun) === alias;
        return [alias, wp ? `paused for ${remaining(wp.until, t)}${wp.reason ? ` (${wp.reason})` : ''}` : busy ? 'working' : 'idle'];
      }),
      'No allowlisted workspaces.'
    ),
    h('h3', null, 'Scheduled jobs'),
    table(
      ['job', 'room', 'daily (UTC)', 'next due'],
      (snap.jobs ?? []).map((j) => [j.name, j.room, j.at, nextDue(j, t)]),
      'No scheduled jobs.'
    ),
  ];
}

// --- live log (Now tab) ---

/** Shown on the Now tab once a run's log has arrived (it stays after the run, until the next one). */
function showLog() {
  document.getElementById('log').hidden = currentTab() !== 'now' || !pane.runId;
}

function renderLog() {
  const lines = document.getElementById('log-lines');
  lines.textContent = pane.lines.join('\n');
  document.getElementById('log-run').textContent = pane.runId ?? '';
  if (following) lines.scrollTop = lines.scrollHeight;
}

function toggleFollow() {
  following = !following;
  document.getElementById('log-follow').textContent = following ? 'Pause scrolling' : 'Resume scrolling';
  if (following) renderLog();
}

const RENDER = { now: renderNow, issues: renderIssues, history: renderHistory, office: renderOffice };

function currentTab() {
  const tab = location.hash.slice(1);
  return TABS.includes(tab) ? tab : 'now';
}

function render() {
  const tab = currentTab();
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === `#${tab}`);
  const status = document.getElementById('status');
  status.textContent = up ? 'live' : 'runner down, reconnecting…';
  status.className = up ? 'up' : 'down';
  document.body.classList.toggle('down', !up);
  const panel = document.getElementById('panel');
  if (!snap) panel.replaceChildren(h('p', { class: 'dim' }, up ? 'Waiting for the first snapshot…' : 'Runner down: no snapshot yet.'));
  // a tab's optional parts (e.g. the filter note) are null when absent
  else panel.replaceChildren(...RENDER[tab]().filter((x) => x != null));
  showLog();
  drawScene();
}

// --- the office floor ---

function drawScene() {
  const t = snap ? now() : Date.now();
  scene = reduceScene(snap, scene, { up, now: t, config, log: pane });
  const floor = document.getElementById('floor');
  const canvas = sceneCanvas;
  const dpr = window.devicePixelRatio || 1;
  const fit = fitScene(floor.clientWidth, window.innerHeight - document.querySelector('header').offsetHeight - 48, dpr);
  const next = layoutOffice(scene.cubicles.length, fit.mode, fit.width);
  // the pointer was placed over the old floor plan, so it may be over something else now: drop
  // the tip until the pointer moves again
  if (!sameLayout(layout, next) || canvas.width !== next.width * fit.scale || canvas.height !== next.height * fit.scale) pointer = null;
  layout = next;
  // resizing clears a canvas, so only when the size changes (this runs every animation frame)
  if (buffer.width !== layout.width || buffer.height !== layout.height) {
    buffer.width = layout.width;
    buffer.height = layout.height;
  }
  drawOffice(buffer.getContext('2d'), layout, scene, { t, filter });
  if (canvas.width !== layout.width * fit.scale || canvas.height !== layout.height * fit.scale) {
    canvas.width = layout.width * fit.scale;
    canvas.height = layout.height * fit.scale;
  }
  canvas.style.width = `${canvas.width / dpr}px`;
  canvas.style.height = `${canvas.height / dpr}px`;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);
  showTip();
}

/** The pointer in the scene's internal pixels. @param {{ x: number, y: number }} p */
function scenePoint(p) {
  return { x: (p.x * layout.width) / sceneCanvas.clientWidth, y: (p.y * layout.height) / sceneCanvas.clientHeight };
}

/** @param {string | null} alias */
function setFilter(alias) {
  filter = alias;
  render();
}

/** A click on a cubicle (or its worker) filters the panel to its workspace; again, or elsewhere, clears it. @param {MouseEvent} e */
function clickFloor(e) {
  if (!scene || !layout || scene.dark) return;
  const r = sceneCanvas.getBoundingClientRect();
  const { x, y } = scenePoint({ x: e.clientX - r.left, y: e.clientY - r.top });
  setFilter(clickFilter(layout, scene.cubicles, x, y, filter));
}

/** Same floor plan: same size and the same rooms in the same places. @param {any} a @param {any} b */
const sameLayout = (a, b) => !!a && JSON.stringify(a) === JSON.stringify(b);

/**
 * A room's last run, for the hover: how it went, when, and its PR.
 * @param {import('./scene.js').SceneOutcome | undefined} o
 */
function lastRun(o) {
  if (!o) return '';
  const pr = o.prUrl ? `\nPR: ${o.prUrl}` : '';
  const how = o.outcome === o.recorded ? o.outcome : `${o.outcome} (${o.recorded})`;
  return `\nLast run: ${how}, ended ${ago(new Date(o.endedAt).toISOString(), now())}\n${o.label ?? o.runId}${pr}`;
}

/** @param {{ number: number, title: string, blocked?: boolean }} i */
const issueTip = (i) => `#${i.number} ${i.title}${i.blocked ? ' (blocked)' : ''}`;

/**
 * A pending issue under the pointer: an in-tray letter, a sticky note, or a folder on the boss's desk.
 * @param {number} x @param {number} y
 */
function pendingAt(x, y) {
  for (const [i, c] of scene.cubicles.entries()) {
    const r = layout.cubicles[i];
    if (!r) continue;
    const slot = inTraySlots(r, c.inTray).find((sl) => inside(sl.rect, x, y));
    if (slot) return slot.letters.length > 1 ? `${slot.letters.length} more:\n${slot.letters.map(issueTip).join('\n')}` : `Ready for agent: ${issueTip(slot.letters[0])}`;
    if (c.sticky.length && inside(stickyNote(r), x, y)) return `Ready for human:\n${c.sticky.map(issueTip).join('\n')}`;
  }
  return folderSlots(layout, scene.cubicles, scene.outcomes, scene.parked).find((f) => inside(f.rect, x, y))?.tip ?? null;
}

/** The scheduled job whose worker is at (x, y), if any. @param {number} x @param {number} y */
function jobWorkerAt(x, y) {
  for (const c of scene.cubicles) {
    for (const j of c.jobs) {
      const d = deskAt(layout, scene.cubicles, { room: 'cubicle', alias: c.alias, job: j.name });
      if (d && inside(workerRect(d), x, y)) return j;
    }
  }
  return null;
}

/** What's under the pointer: a letter's label, a pending issue, the cron countdown, or a room (a cubicle's workspace) and its last run. */
function hovered() {
  if (!pointer || !scene || !layout || scene.dark) return null;
  const { x, y } = scenePoint(pointer);
  const run = scene.run;
  const desk = run && deskAt(layout, scene.cubicles, run.place);
  if (run && desk && inside(workerRect(desk), x, y)) return `${run.label ?? run.runId}${run.activity ? `: ${run.activity}` : ''}`;
  const job = jobWorkerAt(x, y);
  if (job) return `Scheduled job ${job.name} (${job.worker}), daily at ${job.at} UTC\nNext due ${nextDue(job, now())}`;
  const slot = cartSlots(layout, scene.queueRoom.letters).find((sl) => inside(sl.rect, x, y));
  if (slot) return slot.label;
  const pending = pendingAt(x, y);
  if (pending) return pending;
  if (scene.queueRoom.countdownMs != null && inside(layout.clock, x, y)) return `Next cron tick in ${formatDuration(scene.queueRoom.countdownMs)}`;
  const i = layout.cubicles.findIndex((r) => inside(r, x, y));
  const c = scene.cubicles[i];
  if (c) {
    const o = scene.outcomes.find((x) => samePlace(x.place, { room: 'cubicle', alias: c.alias }));
    const jobs = c.jobs.map((j) => `\n${j.name}: next due ${nextDue(j, now())}`).join('');
    return `${c.name}${c.name === c.alias ? '' : ` (${c.alias})`}${c.doNotDisturb ? ': do not disturb' : ''}${jobs}${lastRun(o)}`;
  }
  const room = scene.outcomes.find((o) => {
    const r = o.place.room !== 'cubicle' && placeRect(layout, scene.cubicles, o.place);
    return r && inside(r, x, y);
  });
  if (room) return `${placeName(layout, scene.cubicles, room.place)}${lastRun(room)}`;
  return null;
}

function showTip() {
  const tip = document.getElementById('tip');
  const label = hovered();
  tip.hidden = !label;
  if (!label) return;
  const canvas = sceneCanvas;
  tip.textContent = label;
  // the canvas is centred in #floor, which the tip is positioned in
  const left = canvas.offsetLeft + pointer.x + 12;
  tip.style.left = `${Math.min(left, canvas.offsetLeft + canvas.clientWidth - tip.offsetWidth)}px`;
  tip.style.top = `${canvas.offsetTop + pointer.y + 16}px`;
}

/** @param {PointerEvent} e */
function trackPointer(e) {
  const r = sceneCanvas.getBoundingClientRect();
  pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
  showTip();
}

// --- feed ---

function setUp(value) {
  if (up === value) return;
  up = value;
  render();
}

function armSilenceTimer() {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(() => {
    setUp(false);
    connect();
  }, SILENCE_MS);
}

function connect() {
  clearTimeout(reconnectTimer);
  source?.close();
  source = new EventSource(FEED_URL);
  armSilenceTimer();
  source.addEventListener('snapshot', (e) => {
    snap = JSON.parse(e.data);
    receivedAt = Date.now();
    armSilenceTimer();
    up = true;
    render();
  });
  source.addEventListener('log', (e) => {
    pane = applyLogEvent(pane, JSON.parse(e.data));
    // visible first, or the scroll to the bottom does nothing
    showLog();
    renderLog();
    // a job's speech bubble is its latest line
    if (snap?.activeRun?.kind === 'job') drawScene();
  });
  source.addEventListener('error', () => {
    setUp(false);
    // EventSource retries a dropped connection itself, but gives up on an HTTP error (e.g. nginx's
    // 502 while the runner is down), so start over
    if (source?.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}

window.addEventListener('hashchange', () => {
  render();
  // the pane was hidden, so it couldn't follow
  if (following) renderLog();
});
document.getElementById('log-follow').addEventListener('click', toggleFollow);
sceneCanvas.addEventListener('pointermove', trackPointer);
sceneCanvas.addEventListener('pointerdown', trackPointer);
sceneCanvas.addEventListener('click', clickFloor);
sceneCanvas.addEventListener('pointerleave', () => {
  pointer = null;
  showTip();
});
window.addEventListener('resize', drawScene);
fetch('office.json', { cache: 'no-cache' })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}))
  .then((c) => {
    config = c;
    render();
  });
// keeps elapsed times and countdowns moving between snapshots
setInterval(() => snap && render(), 1000);
// and the floor's animations in between
setInterval(() => scene && snap && layout && walkers(layout, scene.cubicles, scene, now()).animating && drawScene(), REDRAW_MS);
render();
connect();
