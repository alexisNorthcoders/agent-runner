import { ALL } from './manualPause.js';
import { spend, totalTokens } from './statusFormat.js';

/**
 * The office snapshot: what the office feed (src/officeFeed.js) sends to the dashboard. It is the
 * status snapshot `agent:status` renders (src/statusCollect.js), plus the live phase and progress
 * this process holds in memory, reshaped into an explicit contract for the page. Every later
 * dashboard feature builds on this shape, so change it by adding fields, and bump `version` on a
 * breaking change.
 *
 * The page is served on the LAN, so the snapshot carries no paths (log, workspace), reply
 * addresses or prompts: runs are named by their label, and workspaces by their alias.
 *
 * @typedef {import('./activeRuns.js').RunHealth} RunHealth
 *
 * @typedef {{
 *   runId: string,
 *   kind: string | null,
 *   trigger: import('./runLock.js').RunTrigger,
 *   label: string | null,
 *   workspaceAlias: string | null,
 *   inferredWorkspace: string | null,
 *   issueNumber: number | null,
 *   room: string | null,
 *   health: RunHealth,
 *   phase: 'agent' | 'post-run' | 'job' | null,
 *   model: string | null,
 *   turns: number,
 *   outputTokens: number,
 *   contextTokens: number,
 *   lastActivity: string | null,
 *   startedAt: string | null,
 *   elapsedMs: number | null,
 *   agentPid: number | null,
 * }} OfficeRun
 *   An in-flight run. `trigger` is `cron` for the cron issue tracer, `schedule` for a scheduled
 *   job (`kind: job`, with its `room`), else `manual` (WhatsApp or HTTP). `inferredWorkspace`: the
 *   allowlisted workspace a freeform run turned out to work in, once its first edit or command
 *   there is seen (null until then, and for other kinds). A job's phase is `job`. `phase` is known only for the run this process is executing (null for an orphaned or
 *   stale one). `elapsedMs` is as of the snapshot's `at`.
 *
 * @typedef {{
 *   runId: string,
 *   kind: string | null,
 *   trigger: import('./runLock.js').RunTrigger,
 *   label: string | null,
 *   workspaceAlias: string | null,
 *   inferredWorkspace: string | null,
 *   issueNumber: number | null,
 *   room: string | null,
 *   startedAt: string | null,
 *   endedAt: string,
 *   durationMs: number | null,
 *   outcome: string,
 *   result: string | null,
 *   prUrl: string | null,
 *   model: string | null,
 *   turns: number,
 *   costUsd: number | null,
 *   tokens: number,
 * }} OfficeHistoryEntry
 *   A finished run. `outcome` is the agent's (`success`, `failed`, `timeout`, `stopped`,
 *   `spawn_error`), or `interrupted` for a run a restart cut off; `result` is an issue run's
 *   pipeline result (`merged`, `pr_open`, `pushed`, `no_changes`, …), and `prUrl` its PR's.
 *   `tokens` is the total over input, output and cache. `inferredWorkspace`: as on `OfficeRun`.
 *
 * @typedef {{ runs: number, costUsd: number, tokens: number }} SpendTotals
 *
 * @typedef {{ reason: string, pausedAt: string, until: string }} OfficeManualPause
 *
 * @typedef {{
 *   restart: { reason: string, pausedAt: string | null } | null | 'unknown',
 *   general: OfficeManualPause | null,
 *   workspaces: Array<OfficeManualPause & { alias: string }>,
 * }} OfficePauses
 *   `restart` is the safe-restart pause flag (`unknown` when Redis couldn't be read). `general` and
 *   `workspaces` are the owner's pauses by hand.
 *
 * @typedef {{
 *   alive: boolean,
 *   pid: number,
 *   intervalMs: number,
 *   lastTickStartedAt: string | null,
 *   lastTickEndedAt: string | null,
 *   outcome: import('./cronState.js').CronTickOutcome | null,
 *   nextTickAt: string | null,
 * }} OfficeCron
 *   `nextTickAt` is the last tick's start plus the interval, as `agent:status` predicts it (null
 *   before the first tick or while the cron's process is gone).
 *
 * @typedef {{
 *   runId: string,
 *   kind: string | null,
 *   trigger: import('./runLock.js').RunTrigger,
 *   label: string | null,
 *   workspaceAlias: string | null,
 *   inferredWorkspace: string | null,
 *   issueNumber: number | null,
 *   room: string | null,
 *   startedAt: string | null,
 * }} OfficeLock
 *
 * @typedef {{
 *   version: 1,
 *   at: string,
 *   activeRun: OfficeRun | null,
 *   active: OfficeRun[],
 *   queue: Array<{ id: string, kind: string, label: string, queuedAt: string }>,
 *   pauses: OfficePauses,
 *   cron: OfficeCron | null,
 *   lock: OfficeLock | null,
 *   history: OfficeHistoryEntry[],
 *   spend: { today: SpendTotals, week: SpendTotals },
 *   workspaces: string[],
 * }} OfficeSnapshot
 *   `at`: when the snapshot was taken (ISO). `activeRun`: the run this runner is executing, if any.
 *   `active`: every in-flight run `agent:status` lists, including orphaned and stale ones, oldest
 *   first. `queue`: oldest first. `history`: the last 7 days, newest first. `spend`: today (since
 *   local midnight) and the last 7 days. `workspaces`: the allowlisted aliases, sorted.
 *
 * @typedef {{ runId: string, phase?: 'agent' | 'post-run' | 'job', inferredWorkspace?: string } & Partial<import('./agentBackend/index.js').AgentProgress>} LiveRun
 *   What this process knows about the run it's executing (from `runner.status()`), fresher than
 *   the throttled active-run file.
 */

/** @param {string | null | undefined} iso @param {number} now */
const elapsedSince = (iso, now) => (iso && Number.isFinite(Date.parse(iso)) ? now - Date.parse(iso) : null);

/** @param {unknown} trigger @returns {import('./runLock.js').RunTrigger} */
const triggerOf = (trigger) => (trigger === 'cron' || trigger === 'schedule' ? trigger : 'manual');

/** @param {unknown} room @returns {string | null} */
const roomOf = (room) => (typeof room === 'string' ? room : null);

/** @param {unknown} alias @returns {string | null} */
const aliasOf = (alias) => (typeof alias === 'string' ? alias : null);

/**
 * @param {import('./activeRuns.js').ActiveRun} r
 * @param {LiveRun | null} live
 * @param {number} now
 * @returns {OfficeRun}
 */
function officeRun(r, live, now) {
  const mine = live && live.runId === r.runId && r.health === 'running' ? live : null;
  const p = { ...r, ...(mine ?? {}) };
  return {
    runId: r.runId,
    kind: r.kind ?? null,
    trigger: triggerOf(r.trigger),
    label: r.label ?? null,
    workspaceAlias: r.workspaceAlias ?? null,
    inferredWorkspace: aliasOf(p.inferredWorkspace),
    issueNumber: r.issueNumber ?? null,
    room: roomOf(r.room),
    health: r.health,
    phase: mine?.phase ?? null,
    model: p.model ?? null,
    turns: p.turns ?? 0,
    outputTokens: p.outputTokens ?? 0,
    contextTokens: p.contextTokens ?? 0,
    lastActivity: p.lastActivity ?? null,
    startedAt: r.startedAt ?? null,
    elapsedMs: elapsedSince(r.startedAt, now),
    agentPid: r.agentPid ?? null,
  };
}

/** @param {import('./runHistory.js').HistoryEntry} h @returns {OfficeHistoryEntry} */
function historyEntry(h) {
  const durationMs = h.durationMs ?? (h.startedAt ? Date.parse(h.endedAt) - Date.parse(h.startedAt) : null);
  return {
    runId: h.runId,
    kind: h.kind ?? null,
    trigger: triggerOf(h.trigger),
    label: h.label ?? null,
    workspaceAlias: typeof h.workspaceAlias === 'string' ? h.workspaceAlias : null,
    inferredWorkspace: aliasOf(h.inferredWorkspace),
    issueNumber: typeof h.issueNumber === 'number' ? h.issueNumber : null,
    room: roomOf(h.room),
    startedAt: h.startedAt ?? null,
    endedAt: h.endedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    outcome: h.outcome,
    result: typeof h.result === 'string' ? h.result : null,
    prUrl: typeof h.prUrl === 'string' ? h.prUrl : null,
    model: h.model ?? null,
    turns: h.turns ?? 0,
    costUsd: h.costUsd ?? null,
    tokens: totalTokens(h.tokens),
  };
}

/** @param {import('./manualPause.js').ManualPause} p @returns {OfficeManualPause} */
const manualPause = (p) => ({ reason: p.reason, pausedAt: p.pausedAt, until: p.until });

/**
 * @param {{ status: import('./statusCollect.js').StatusSnapshot, live: LiveRun | null, workspaces: string[] }} p
 * @returns {OfficeSnapshot}
 */
export function buildOfficeSnapshot({ status: d, live, workspaces }) {
  const active = d.active.map((r) => officeRun(r, live, d.now));
  const manual = d.manualPauses ?? [];
  const general = manual.find((p) => p.scope === ALL);
  const { today, week } = spend(d);
  /** @param {{ n: number, cost: number, tokens: number }} t @returns {SpendTotals} */
  const totals = (t) => ({ runs: t.n, costUsd: t.cost, tokens: t.tokens });
  const lastStart = d.cron?.lastTickStartedAt ? Date.parse(d.cron.lastTickStartedAt) : NaN;
  return {
    version: 1,
    at: new Date(d.now).toISOString(),
    activeRun: active.find((r) => r.phase != null) ?? active.find((r) => r.health === 'running') ?? null,
    active,
    queue: (d.queue ?? []).map((q) => ({ id: q.id, kind: q.cmd.kind, label: q.label, queuedAt: q.queuedAt })),
    pauses: {
      restart: d.paused === 'unknown' ? 'unknown' : d.paused ? { reason: d.paused.reason, pausedAt: d.paused.pausedAt } : null,
      general: general ? manualPause(general) : null,
      workspaces: manual.filter((p) => p.scope !== ALL).map((p) => ({ alias: p.scope, ...manualPause(p) })),
    },
    cron: d.cron
      ? {
          alive: d.cronAlive,
          pid: d.cron.pid,
          intervalMs: d.cron.intervalMs,
          lastTickStartedAt: d.cron.lastTickStartedAt,
          lastTickEndedAt: d.cron.lastTickEndedAt,
          outcome: d.cron.outcome,
          nextTickAt: d.cronAlive && Number.isFinite(lastStart) ? new Date(lastStart + d.cron.intervalMs).toISOString() : null,
        }
      : null,
    lock: d.lock
      ? {
          runId: d.lock.runId,
          kind: d.lock.kind ?? null,
          trigger: triggerOf(d.lock.trigger),
          label: d.lock.label ?? null,
          workspaceAlias: d.lock.workspaceAlias ?? null,
          inferredWorkspace: aliasOf(d.lock.inferredWorkspace),
          issueNumber: d.lock.issueNumber ?? null,
          room: roomOf(d.lock.room),
          startedAt: d.lock.startedAt ?? null,
        }
      : null,
    history: d.history.map(historyEntry),
    spend: { today: totals(today), week: totals(week) },
    workspaces,
  };
}

/**
 * Read everything a snapshot needs and build it. The allowlist is config, so a broken map file
 * shows as no workspaces instead of failing the feed.
 * @param {{
 *   statusSnapshot: () => Promise<import('./statusCollect.js').StatusSnapshot>,
 *   liveRun: () => Promise<{ activeRun: LiveRun | null }>,
 *   workspaceAliases: () => Promise<string[]>,
 * }} deps
 * @returns {Promise<OfficeSnapshot>}
 */
export async function collectOfficeSnapshot({ statusSnapshot, liveRun, workspaceAliases }) {
  const [status, live, workspaces] = await Promise.all([
    statusSnapshot(),
    liveRun().then((s) => s.activeRun, () => null),
    workspaceAliases().catch(() => []),
  ]);
  return buildOfficeSnapshot({ status, live, workspaces });
}
