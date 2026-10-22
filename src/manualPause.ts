import { errorText, parseJsonObject } from './narrow.ts';
import type { Store } from './redisStore.ts';
import type { createUsageLimitPause } from './usageLimitPause.ts';

/**
 * Pauses the owner sets by hand (`claude:pause` / `npm run agent:pause`) before working in a repo
 * themselves. Separate from the safe-restart pause flag (`pauseFlag.ts`), so a restart still works
 * while one is set.
 *
 * - The general pause stops every new run: requests queue, the cron skips its ticks.
 * - A workspace pause stops issue runs (cron and `claude issue:…`) in that workspace alias, and
 *   freeform runs are told to leave it alone. Runs elsewhere carry on.
 *
 * A run that is already going is not stopped. Each pause is a field of one Redis hash with its end
 * time inside; an expired one reads as absent and is deleted lazily.
 */
/** `scope` is `all` for the general pause, else the workspace alias. */
export type ManualPause = { scope: string; reason: string; pausedAt: string; until: string };

export const MANUAL_PAUSE_KEY = 'agent-runner:manual-pause';
export const ALL = 'all';
export const DEFAULT_MANUAL_PAUSE_SECONDS = 2 * 60 * 60;
export const MAX_MANUAL_PAUSE_SECONDS = 7 * 24 * 60 * 60;

const DURATION_RE = /^(\d+)(m|h|d)$/i;
const UNIT_SECONDS = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };

/** `30m`, `2h`, `1d` → seconds, or null when `s` isn't a duration. */
export function parseDuration(s: string) {
  const m = DURATION_RE.exec(String(s).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n * UNIT_SECONDS[(m[2].toLowerCase() as 'm' | 'h' | 'd')] : null;
}

/** Compact remaining time, e.g. `1h20m`, `45m`, `2d3h`. */
export function formatRemaining(ms: number) {
  const mins = Math.max(1, Math.ceil(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d) return `${d}d${h ? `${h}h` : ''}`;
  if (h) return `${h}h${m ? `${m}m` : ''}`;
  return `${m}m`;
}

function parse(raw: string): ManualPause | null {
  const p = parseJsonObject(raw);
  if (typeof p?.scope !== 'string' || typeof p.until !== 'string') return null;
  return {
    scope: p.scope,
    reason: typeof p.reason === 'string' ? p.reason : '',
    pausedAt: typeof p.pausedAt === 'string' ? p.pausedAt : p.until,
    until: p.until,
  };
}

export function createManualPause({ store, key = MANUAL_PAUSE_KEY, now = Date.now }: { store: Store; key?: string; now?: () => number }) {
  /** @returns live pauses, the general one first, then by alias */
  async function list(): Promise<ManualPause[]> {
    const all = await store.hashGetAll(key);
    const live: ManualPause[] = [];
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
     * Set (or replace) a pause.
     */
    async set({ scope, seconds, reason = '' }: { scope: string; seconds: number; reason?: string }): Promise<ManualPause> {
      const t = now();
      const p = { scope, reason, pausedAt: new Date(t).toISOString(), until: new Date(t + seconds * 1000).toISOString() };
      await store.hashSet(key, scope, JSON.stringify(p));
      return p;
    },
    /** @returns whether a live pause was cleared */
    async clear(scope: string): Promise<boolean> {
      const had = (await list()).some((p) => p.scope === scope);
      await store.hashDelete(key, scope);
      return had;
    },
    /** @returns how many live pauses were cleared */
    async clearAll(): Promise<number> {
      const live = await list();
      for (const p of live) await store.hashDelete(key, p.scope);
      return live.length;
    },
    /** The general pause, if set. */
    general: async () => (await list()).find((p) => p.scope === ALL) ?? null,
    /** The pause covering `alias`: its own, else null (the general one is checked separately). */
    forWorkspace: async (alias: string) => (await list()).find((p) => p.scope === alias) ?? null,
  };
}

/** One line for a pause, e.g. `chess-trainer for 1h20m (fixing lessons)`. */
export function describeManualPause(p: ManualPause, nowMs: number) {
  const what = p.scope === ALL ? 'everything' : p.scope;
  return `${what} for ${formatRemaining(Date.parse(p.until) - nowMs)}${p.reason ? ` (${p.reason})` : ''}`;
}

/**
 * Apply a parsed `pause` / `resume` command. Shared by `claude:pause` and the `agent:pause` CLI.
 * A resume with no scope also ends the usage-limit pause. `ok` is false when nothing was applied
 * (an unknown workspace alias).
 */
export async function applyPauseCommand(p: {
    manualPause: ReturnType<typeof createManualPause>;
    usageLimit?: Pick<ReturnType<typeof createUsageLimitPause>, 'clear'>;
    workspaces?: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    cmd: { kind: 'pause'; scope: string; seconds: number; reason: string } | { kind: 'resume'; scope: string | null };
    now?: () => number;
  }) {
  try {
    return { ok: true, reply: await apply(p) };
  } catch (err) {
    if (!(err instanceof UnknownScope)) throw err;
    return { ok: false, reply: err.message };
  }
}

class UnknownScope extends Error {}

async function apply({ manualPause, usageLimit, workspaces, cmd, now = Date.now }: Parameters<typeof applyPauseCommand>[0]) {
  let scope = cmd.scope;
  if (scope && scope !== ALL) {
    if (!workspaces) throw new UnknownScope('Workspace pauses need CLAUDE_WORKSPACE_MAP.');
    try {
      scope = (await workspaces.resolveIssueWorkspace(scope)).alias;
    } catch (err) {
      throw new UnknownScope(errorText(err));
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
    if (await manualPause.clear(scope)) return `Resumed ${scope === ALL ? 'everything' : scope}.`;
    return scope === ALL ? 'There was no general pause.' : `${scope} was not paused.`;
  }
  const n = await manualPause.clearAll();
  const limit = (await usageLimit?.clear()) ?? false;
  const cleared = [n ? `${n} pause${n === 1 ? '' : 's'}` : '', limit ? 'the usage-limit pause' : ''].filter(Boolean);
  return cleared.length ? `Resumed: cleared ${cleared.join(' and ')}.` : 'Nothing was paused.';
}
