// The office dashboard: listens to the office feed (`feed`, next to this page), draws the office
// floor on a canvas, and renders the panel's Now, History and Office tabs as text and tables. No
// build step, no dependencies. The snapshot shape is `OfficeSnapshot` in src/officeSnapshot.js.
import { ago, describeCronOutcome, formatCost, formatDuration, formatTokens, formatTotals, remaining, shortModel, what } from './format.js';
import { cartSlots, clickFilter, deskAt, fitScene, inside, layoutOffice, workerRect } from './layout.js';
import { applyLogEvent } from './logPane.js';
import { animating, drawOffice } from './officeView.js';
import { reduceScene } from './scene.js';

const FEED_URL = 'feed';
const RECONNECT_MS = 3000;
// the feed resends the snapshot every 30s, so this much silence means the connection is dead
const SILENCE_MS = 75_000;
const TABS = ['now', 'history', 'office'];
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

/** The snapshot's clock, advanced by the time since it arrived. */
const now = () => Date.parse(snap.at) + (Date.now() - receivedAt);

// --- tabs ---

function renderNow() {
  const t = now();
  const out = [];
  const run = snap.activeRun;
  if (!run) out.push(h('p', null, 'Agent: idle'));
  else {
    out.push(
      h('h2', null, what(run)),
      dl([
        ['trigger', run.trigger],
        ['workspace', run.workspaceAlias ?? '-'],
        ['issue', run.issueNumber != null ? `#${run.issueNumber}` : '-'],
        ['phase', run.phase ?? '-'],
        ['model', shortModel(run.model)],
        ['elapsed', formatDuration(run.elapsedMs == null ? null : run.elapsedMs + (Date.now() - receivedAt))],
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
  const rows = filter ? snap.history.filter((r) => r.workspaceAlias === filter) : snap.history;
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
      ['lock', lock],
      ['queue', snap.queue.length ? `${snap.queue.length} waiting (next: ${snap.queue[0].label})` : 'empty'],
    ]),
    h('h3', null, 'Workspaces'),
    table(
      ['workspace', 'state'],
      snap.workspaces.map((alias) => {
        const wp = paused.get(alias);
        const busy = snap.activeRun?.workspaceAlias === alias;
        return [alias, wp ? `paused for ${remaining(wp.until, t)}${wp.reason ? ` (${wp.reason})` : ''}` : busy ? 'working' : 'idle'];
      }),
      'No allowlisted workspaces.'
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

const RENDER = { now: renderNow, history: renderHistory, office: renderOffice };

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
  else panel.replaceChildren(...RENDER[tab]());
  showLog();
  drawScene();
}

// --- the office floor ---

function drawScene() {
  const t = snap ? now() : Date.now();
  scene = reduceScene(snap, scene, { up, now: t, config });
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

/** What's under the pointer: a letter's label, the cron countdown, or a cubicle's workspace. */
function hovered() {
  if (!pointer || !scene || !layout || scene.dark) return null;
  const { x, y } = scenePoint(pointer);
  const run = scene.run;
  const desk = run && deskAt(layout, scene.cubicles, run.place);
  if (run && desk && inside(workerRect(desk), x, y)) return `${run.label ?? run.runId}${run.activity ? `: ${run.activity}` : ''}`;
  const slot = cartSlots(layout, scene.reception.letters).find((sl) => inside(sl.rect, x, y));
  if (slot) return slot.label;
  if (scene.reception.countdownMs != null && inside(layout.clock, x, y)) return `Next cron tick in ${formatDuration(scene.reception.countdownMs)}`;
  const i = layout.cubicles.findIndex((r) => inside(r, x, y));
  const c = scene.cubicles[i];
  if (c) return `${c.name}${c.name === c.alias ? '' : ` (${c.alias})`}${c.doNotDisturb ? ': do not disturb' : ''}`;
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
setInterval(() => scene && snap && animating(scene, now()) && drawScene(), REDRAW_MS);
render();
connect();
