/**
 * Pure formatting for the dashboard page, with no DOM so `node:test` can check it. The numbers
 * mirror `src/statusFormat.js` (test/dashboardFormat.test.js keeps them in step), so the page
 * shows the same values as `npm run agent:status`.
 */

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

/** @param {string | null | undefined} model */
export function shortModel(model) {
  if (!model) return '-';
  return model.replace(/-\d{8}$/, '');
}

/** `2 runs · $0.50 · 10 tok` @param {{ runs: number, costUsd: number, tokens: number }} t */
export const formatTotals = (t) => `${t.runs} run${t.runs === 1 ? '' : 's'} · ${formatCost(t.costUsd)} · ${formatTokens(t.tokens)} tok`;

/** `5m00s ago`, or '-' @param {string | null | undefined} iso @param {number} now */
export function ago(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${formatDuration(now - t)} ago` : '-';
}

/** Compact remaining time until `iso`, e.g. `1h20m` (as `claude:pause` shows it). @param {string} iso @param {number} now */
export function remaining(iso, now) {
  const mins = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d${h ? `${h}h` : ''}`;
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  return `${m}m`;
}

/** The cron's last tick, in the words of `agent:status`. @param {{ kind: string, repo?: string, issue?: number, result?: string, note?: string } | null} o */
export function describeCronOutcome(o) {
  if (!o) return 'starting (no tick finished yet)';
  switch (o.kind) {
    case 'busy':
      return 'skipped, an agent was already running';
    case 'paused':
      return 'skipped, agent-runner was paused';
    case 'no_eligible':
      return 'idle, no eligible issue';
    case 'ran': {
      /** @type {Record<string, string>} */
      const labels = {
        progress: 'made progress',
        no_progress: 'no lasting progress',
        prep_failed: 'issue fetch or git prep failed',
        failed: 'failed',
        timeout: 'timed out',
        no_changes: 'made no changes',
        merge_retry: 'merge retried next tick',
      };
      const label = labels[o.result ?? ''] ?? o.result;
      return `worked ${o.repo}#${o.issue}, ${label}${o.note ? ` (${o.note})` : ''}`;
    }
    case 'error':
      return `error: ${o.note ?? 'unknown'}`;
    default:
      return o.kind;
  }
}

/** What a run was asked to do. @param {{ label: string | null, kind: string | null, runId: string }} r */
export const what = (r) => r.label || r.kind || r.runId;
