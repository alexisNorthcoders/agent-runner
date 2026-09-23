/**
 * Pure text rendering of a status snapshot (src/statusCollect.js): a pm2-style dashboard for the
 * terminal CLI, and compact plain text for `claude:status` / `claude:history` replies (a single
 * WhatsApp message each, with no log paths or excerpts). Ported from WhatsappBot's
 * `claudeAgentCliFormat.js`. `c` is a colorizer so tests can pass identity functions.
 */

/** @typedef {import('./statusCollect.js').StatusSnapshot} StatusSnapshot */
/** @typedef {import('./runHistory.js').HistoryEntry} HistoryEntry */
/** @typedef {import('./activeRuns.js').ActiveRun} ActiveRun */
/** @typedef {Record<'dim' | 'green' | 'red' | 'yellow' | 'bold' | 'cyan', (s: string) => string>} Colors */

/** @type {Colors} */
export const plain = { dim: (s) => s, green: (s) => s, red: (s) => s, yellow: (s) => s, bold: (s) => s, cyan: (s) => s };

/** @returns {Colors} */
export function ansi() {
  const wrap = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
  return { dim: wrap(2), green: wrap(32), red: wrap(31), yellow: wrap(33), bold: wrap(1), cyan: wrap(36) };
}

const DAY_MS = 864e5;

/** @param {number | null | undefined} ms */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '-';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** @param {number | null | undefined} n */
export function formatTokens(n) {
  if (n == null) return '-';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/** @param {number | null | undefined} usd */
export function formatCost(usd) {
  return usd == null ? '-' : `$${usd.toFixed(usd < 10 ? 2 : 1)}`;
}

/** `claude-haiku-4-5-20251001` → `haiku-4-5` @param {string | null | undefined} model */
export function shortModel(model) {
  if (!model) return '-';
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

/** @param {HistoryEntry['tokens']} t */
export function totalTokens(t) {
  return t ? (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0) : 0;
}

const since = (now, iso) => now - Date.parse(iso);
const formatAgo = (ms) => `${formatDuration(ms)} ago`;

/** @param {HistoryEntry} r */
const durationOf = (r) => r.durationMs ?? (r.startedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null);

/** What the run was asked to do. @param {{ label?: string, kind?: string, runId: string }} r */
const what = (r) => r.label || r.kind || r.runId;

/** @param {string} s @param {number} n */
const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** @param {string} s @param {number} n */
const pad = (s, n) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/**
 * pm2-style boxed table. `colorRow(i)` wraps a whole row's cells after padding, so widths hold.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {Colors} [c]
 * @param {(i: number) => (s: string) => string} [colorRow]
 * @returns {string[]}
 */
export function boxTable(headers, rows, c = plain, colorRow = () => (s) => s) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const rule = (l, m, r) => c.dim(`${l}${widths.map((w) => '─'.repeat(w + 2)).join(m)}${r}`);
  const bar = c.dim('│');
  const line = (row, wrap = (x) => x) => `${bar}${row.map((cell, i) => wrap(` ${pad(cell ?? '', widths[i])} `)).join(bar)}${bar}`;
  return [rule('┌', '┬', '┐'), line(headers, c.bold), rule('├', '┼', '┤'), ...rows.map((r, i) => line(r, colorRow(i))), rule('└', '┴', '┘')];
}

/** @param {import('./cronState.js').CronTickOutcome | null} o */
function describeCronOutcome(o) {
  if (!o) return 'starting (no tick finished yet)';
  switch (o.kind) {
    case 'busy':
      return 'skipped, an agent was already running';
    case 'no_eligible':
      return 'idle, no eligible issue';
    case 'ran': {
      const label = { progress: 'made progress', no_progress: 'no lasting progress', prep_failed: 'git prep failed', failed: 'failed' }[o.result] ?? o.result;
      return `worked ${o.repo}#${o.issue}, ${label}${o.note ? ` (${o.note})` : ''}`;
    }
    case 'error':
      return `error: ${o.note ?? 'unknown'}`;
    default:
      return o.kind;
  }
}

/** @param {StatusSnapshot} d */
function spend(d) {
  const dayStart = new Date(d.now);
  dayStart.setHours(0, 0, 0, 0);
  /** @param {HistoryEntry[]} rows */
  const totals = (rows) => ({
    n: rows.length,
    cost: rows.reduce((a, r) => a + (r.costUsd || 0), 0),
    tokens: rows.reduce((a, r) => a + totalTokens(r.tokens), 0),
  });
  return {
    today: totals(d.history.filter((r) => Date.parse(r.endedAt) >= dayStart.getTime())),
    week: totals(d.history.filter((r) => Date.parse(r.endedAt) >= d.now - 7 * DAY_MS)),
  };
}

/** @param {{ n: number, cost: number, tokens: number }} t */
const formatTotals = (t) => `${t.n} run${t.n === 1 ? '' : 's'} · ${formatCost(t.cost)} · ${formatTokens(t.tokens)} tok`;

// --- terminal ---

/**
 * @param {StatusSnapshot} d
 * @param {Colors} [c]
 */
export function renderStatus(d, c = plain) {
  const out = [];
  const stamp = new Date(d.now).toISOString().replace('T', ' ').slice(0, 19);
  out.push(`${c.bold('agent-runner')}  ${c.dim(`${stamp} UTC`)}`, '');

  if (!d.cron) {
    out.push(`${c.bold('CRON')}    ${c.dim('○ no state file (the cron is not running yet)')}`);
  } else {
    const dot = d.cronAlive ? c.green('●') : c.red('●');
    const health = d.cronAlive ? `pid ${d.cron.pid}` : c.red(`pid ${d.cron.pid} NOT running`);
    out.push(`${c.bold('CRON')}    ${dot} every ${formatDuration(d.cron.intervalMs)} · ${health}`);
    if (d.cron.lastTickEndedAt) {
      const next = d.cron.lastTickStartedAt ? Date.parse(d.cron.lastTickStartedAt) + d.cron.intervalMs : null;
      const nextIn = next == null || !d.cronAlive ? '' : next > d.now ? ` · next tick in ~${formatDuration(next - d.now)}` : ' · next tick due';
      out.push(`         last tick ${formatAgo(since(d.now, d.cron.lastTickEndedAt))}: ${describeCronOutcome(d.cron.outcome)}${nextIn}`);
    } else {
      out.push(`         ${describeCronOutcome(null)}`);
    }
  }
  out.push('');

  const bad = d.active.filter((r) => r.health !== 'running').length;
  const count = d.active.length === 0 ? c.dim('none running') : c.green(`${d.active.length} running`);
  out.push(`${c.bold('AGENTS')}  ${count}${bad ? c.red(`  (${bad} need attention)`) : ''}`);
  if (d.active.length) {
    const rows = d.active.map((r) => [
      r.runId,
      r.kind ?? '-',
      clip(what(r), 40),
      shortModel(r.model),
      formatDuration(since(d.now, r.startedAt)),
      String(r.turns ?? 0),
      formatTokens(r.outputTokens ?? 0),
      formatTokens(r.contextTokens ?? 0),
      String(r.agentPid ?? '-'),
      r.health,
    ]);
    const healthColor = (i) => (d.active[i].health === 'running' ? c.green : c.red);
    out.push(...boxTable(['run', 'kind', 'what', 'model', 'elapsed', 'turns', 'out', 'ctx', 'pid', 'state'], rows, c, healthColor));
    for (const r of d.active) {
      if (r.health === 'orphaned') out.push(c.red(`  ${r.runId}: runner died but agent pid ${r.agentPid} is still running; nothing will report its result`));
      else if (r.health === 'stale') out.push(c.yellow(`  ${r.runId}: leftover from a crash (no live process); removed on the next runner start`));
      else if (r.lastActivity) out.push(c.dim(`  ↳ ${r.lastActivity}`));
    }
  }
  out.push('');

  if (d.paused === 'unknown') out.push(`${c.bold('PAUSED')}  ${c.dim('unknown (Redis unreachable)')}`);
  else if (!d.paused) out.push(`${c.bold('PAUSED')}  ${c.dim('no')}`);
  else out.push(`${c.bold('PAUSED')}  ${c.yellow(`yes, ${d.paused.reason}`)}${d.paused.pausedAt ? ` (${formatAgo(since(d.now, d.paused.pausedAt))})` : ''}`);
  out.push('');

  const { today, week } = spend(d);
  out.push(`${c.bold('SPEND')}   today ${formatTotals(today)}    7d ${formatTotals(week)}`, '');

  out.push(c.bold('RECENT'));
  const recent = d.history.slice(0, 8);
  if (!recent.length) out.push(c.dim('  no finished runs recorded yet'));
  else out.push(...renderHistoryLines(recent, d.now, c));
  return out.join('\n');
}

/**
 * Boxed table, one row per run, newest first.
 * @param {HistoryEntry[]} rows
 * @param {number} now
 * @param {Colors} [c]
 * @returns {string[]}
 */
export function renderHistoryLines(rows, now, c = plain) {
  const body = rows.map((r) => [
    formatAgo(since(now, r.endedAt)),
    r.kind ?? '-',
    clip(what(r), 40),
    r.outcome,
    formatDuration(durationOf(r)),
    shortModel(r.model),
    String(r.turns ?? 0),
    formatTokens(r.tokens?.output),
    formatTokens(totalTokens(r.tokens)),
    formatCost(r.costUsd),
    r.runId,
  ]);
  return boxTable(
    ['ended', 'kind', 'what', 'outcome', 'took', 'model', 'turns', 'out tok', 'total tok', 'cost', 'run'],
    body,
    c,
    (i) => (rows[i].outcome === 'success' ? (x) => x : c.red)
  );
}

// --- WhatsApp (plain text, one message) ---

/** @param {HistoryEntry} r @param {number} now */
const historyLine = (r, now) =>
  `${formatAgo(since(now, r.endedAt))} · ${clip(what(r), 60)} — ${r.outcome}, ${formatDuration(durationOf(r))}, ${formatCost(r.costUsd)}, ${formatTokens(totalTokens(r.tokens))} tok`;

export const STATUS_RECENT_COUNT = 3;

/**
 * `claude:status`: active run, pause, last cron tick, today's spend and the last few runs.
 * @param {StatusSnapshot} d
 */
export function renderStatusText(d) {
  const out = [];
  if (!d.active.length) out.push('Agent: idle');
  for (const r of d.active) {
    const progress = r.health === 'running' ? `, ${r.turns ?? 0} turns, ${formatTokens(r.outputTokens ?? 0)} out tok` : '';
    out.push(`Agent: ${clip(what(r), 60)} (${r.health}, ${formatDuration(since(d.now, r.startedAt))}${progress})`);
    if (r.health === 'orphaned') out.push(`⚠ Orphaned: agent-runner restarted but agent pid ${r.agentPid} is still running; nothing will report its result.`);
    else if (r.health === 'stale') out.push('⚠ Stale: leftover from a crash (no live process).');
    else if (r.lastActivity) out.push(`Phase: ${clip(r.lastActivity, 100)}`);
  }

  if (d.paused === 'unknown') out.push('Paused: unknown (Redis unreachable)');
  else if (!d.paused) out.push('Paused: no');
  else out.push(`Paused: yes (${d.paused.reason}${d.paused.pausedAt ? `, ${formatAgo(since(d.now, d.paused.pausedAt))}` : ''})`);

  if (!d.cron) out.push('Cron: not running yet (no ticks recorded)');
  else if (!d.cron.lastTickEndedAt) out.push(`Cron: ${describeCronOutcome(null)}`);
  else {
    const dead = d.cronAlive ? '' : ' [cron process not running]';
    out.push(`Cron: last tick ${formatAgo(since(d.now, d.cron.lastTickEndedAt))} — ${describeCronOutcome(d.cron.outcome)}${dead}`);
  }

  out.push(`Today: ${formatTotals(spend(d).today)}`, '', 'Recent:');
  const recent = d.history.slice(0, STATUS_RECENT_COUNT);
  out.push(recent.length ? recent.map((r) => historyLine(r, d.now)).join('\n') : 'no finished runs recorded yet');
  return out.join('\n');
}

/**
 * `claude:history [n]`: one line per finished run, newest first.
 * @param {HistoryEntry[]} rows
 * @param {number} now
 */
export function renderHistoryText(rows, now) {
  if (!rows.length) return 'No finished runs recorded yet.';
  const header = rows.length === 1 ? 'Last run:' : `Last ${rows.length} runs:`;
  return [header, ...rows.map((r) => historyLine(r, now))].join('\n');
}
