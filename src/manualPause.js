/**
 * Pauses the owner sets by hand (`claude:pause` / `npm run agent:pause`) before working in a repo
 * themselves. Separate from the safe-restart pause flag (`pauseFlag.js`), so a restart still works
 * while one is set.
 *
 * - The general pause stops every new run: requests queue, the cron skips its ticks.
 * - A workspace pause stops issue runs (cron and `claude issue:…`) in that workspace alias, and
 *   freeform runs are told to leave it alone. Runs elsewhere carry on.
 *
 * A run that is already going is not stopped. Each pause is a field of one Redis hash with its end
 * time inside; an expired one reads as absent and is deleted lazily.
 *
 * @typedef {{ scope: string, reason: string, pausedAt: string, until: string }} ManualPause
 *   `scope` is `all` for the general pause, else the workspace alias.
 */

export const MANUAL_PAUSE_KEY = 'agent-runner:manual-pause';
export const ALL = 'all';
export const DEFAULT_MANUAL_PAUSE_SECONDS = 2 * 60 * 60;
export const MAX_MANUAL_PAUSE_SECONDS = 7 * 24 * 60 * 60;

const DURATION_RE = /^(\d+)(m|h|d)$/i;
const UNIT_SECONDS = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/** `30m`, `2h`, `1d` → seconds, or null when `s` isn't a duration. @param {string} s */
export function parseDuration(s) {
  const m = DURATION_RE.exec(String(s).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n * UNIT_SECONDS[/** @type {'m' | 'h' | 'd'} */ (m[2].toLowerCase())] : null;
}

/** Compact remaining time, e.g. `1h20m`, `45m`, `2d3h`. @param {number} ms */
export function formatRemaining(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d${h ? `${h}h` : ''}`;
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  return `${m}m`;
}

/** @param {string} raw @returns {ManualPause | null} */
function parse(raw) {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.scope === 'string' && typeof p.until === 'string') return { reason: '', pausedAt: p.until, ...p };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * @param {{ store: import('./redisStore.js').Store, key?: string, now?: () => number }} p
 */
export function createManualPause({ store, key = MANUAL_PAUSE_KEY, now = Date.now }) {
  /** @returns {Promise<ManualPause[]>} live pauses, the general one first, then by alias */
  async function list() {
    const all = await store.hashGetAll(key);
    /** @type {ManualPause[]} */
    const live = [];
    for (const [field, raw] of Object.entries(all)) {
      const p = parse(raw);
      if (p && Date.parse(p.until) > now()) live.push(p);
      else await store.hashDelete(key, field);
    }
    return live.sort((a, b) => (a.scope === ALL ? -1 : b.scope === ALL ? 1 : a.scope.localeCompare(b.scope)));
  }

  return {
    list,
    /**
     * Set (or replace) a pause. @param {{ scope: string, seconds: number, reason?: string }} p
     * @returns {Promise<ManualPause>}
     */
    async set({ scope, seconds, reason = '' }) {
      const t = now();
      const p = { scope, reason, pausedAt: new Date(t).toISOString(), until: new Date(t + seconds * 1000).toISOString() };
      await store.hashSet(key, scope, JSON.stringify(p));
      return p;
    },
    /** @param {string} scope @returns {Promise<boolean>} whether a live pause was cleared */
    async clear(scope) {
      const had = (await list()).some((p) => p.scope === scope);
      await store.hashDelete(key, scope);
      return had;
    },
    /** @returns {Promise<number>} how many live pauses were cleared */
    async clearAll() {
      const live = await list();
      for (const p of live) await store.hashDelete(key, p.scope);
      return live.length;
    },
    /** The general pause, if set. */
    general: async () => (await list()).find((p) => p.scope === ALL) ?? null,
    /** The pause covering `alias`: its own, else null (the general one is checked separately). @param {string} alias */
    forWorkspace: async (alias) => (await list()).find((p) => p.scope === alias) ?? null,
  };
}

/** One line for a pause, e.g. `chess-trainer for 1h20m (fixing lessons)`. @param {ManualPause} p @param {number} nowMs */
export function describeManualPause(p, nowMs) {
  const what = p.scope === ALL ? 'everything' : p.scope;
  return `${what} for ${formatRemaining(Date.parse(p.until) - nowMs)}${p.reason ? ` (${p.reason})` : ''}`;
}

/**
 * Apply a parsed `pause` / `resume` command. Shared by `claude:pause` and the `agent:pause` CLI.
 * `ok` is false when nothing was applied (an unknown workspace alias).
 * @param {{
 *   manualPause: ReturnType<typeof createManualPause>,
 *   workspaces?: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }> },
 *   cmd: { kind: 'pause', scope: string, seconds: number, reason: string } | { kind: 'resume', scope: string | null },
 *   now?: () => number,
 * }} p
 */
export async function applyPauseCommand(p) {
  try {
    return { ok: true, reply: await apply(p) };
  } catch (err) {
    if (!(err instanceof UnknownScope)) throw err;
    return { ok: false, reply: err.message };
  }
}

class UnknownScope extends Error {}

/** @param {Parameters<typeof applyPauseCommand>[0]} p */
async function apply({ manualPause, workspaces, cmd, now = Date.now }) {
  let scope = cmd.scope;
  if (scope && scope !== ALL) {
    if (!workspaces) throw new UnknownScope('Workspace pauses need CLAUDE_WORKSPACE_MAP.');
    try {
      scope = (await workspaces.resolveIssueWorkspace(scope)).alias;
    } catch (err) {
      throw new UnknownScope(String(err?.message || err));
    }
  }
  if (cmd.kind === 'pause') {
    const p = await manualPause.set({ scope: scope ?? ALL, seconds: cmd.seconds, reason: cmd.reason });
    const effect =
      p.scope === ALL
        ? 'No new agent runs start; requests queue and the cron skips its ticks.'
        : `No issue runs start in ${p.scope}, and freeform runs are told to leave it alone. Other workspaces carry on.`;
    return `Paused ${describeManualPause(p, now())}. ${effect} A run already going is not stopped. Send claude:resume${p.scope === ALL ? '' : ` ${p.scope}`} to end it early.`;
  }
  if (scope) {
    return (await manualPause.clear(scope)) ? `Resumed ${scope === ALL ? 'everything' : scope}.` : `${scope === ALL ? 'Nothing' : scope} was not paused.`;
  }
  const n = await manualPause.clearAll();
  return n ? `Resumed: cleared ${n} pause${n === 1 ? '' : 's'}.` : 'Nothing was paused.';
}
