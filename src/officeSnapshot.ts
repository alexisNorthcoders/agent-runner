import { ALL } from './manualPause.ts';
import { spend, totalTokens, usageLimitText } from './statusFormat.ts';
import type { ActiveRun } from './activeRuns.ts';
import type { AgentProgress } from './agentBackend/index.ts';
import type { HistoryEntry } from './runHistory.ts';
import type { ManualPause } from './manualPause.ts';
import type { StatusSnapshot } from './statusCollect.ts';
import type { JobScheduleEntry, OfficeHistoryEntry, OfficeIssues, OfficeManualPause, OfficeRun, OfficeSession, OfficeSnapshot, RunTrigger, SpendTotals } from './officeWire.ts';

/**
 * What this process knows about the run it's executing (from `runner.status()`), fresher than
 * the throttled active-run file.
 */
export type LiveRun = { runId: string; phase?: 'agent' | 'post-run' | 'job'; inferredWorkspace?: string } & Partial<AgentProgress>;

/** The sessions, or none if reading them fails. */
const safely = (read: () => OfficeSession[]) => {
  try {
    return read();
  } catch {
    return [];
  }
};

const elapsedSince = (iso: string | null | undefined, now: number) => (iso && Number.isFinite(Date.parse(iso)) ? now - Date.parse(iso) : null);

const triggerOf = (trigger: unknown): RunTrigger => (trigger === 'cron' || trigger === 'schedule' ? trigger : 'manual');

const roomOf = (room: unknown): string | null => (typeof room === 'string' ? room : null);

const jobNameOf = (name: unknown): string | null => (typeof name === 'string' ? name : null);

const aliasOf = (alias: unknown): string | null => (typeof alias === 'string' ? alias : null);

function officeRun(r: ActiveRun, live: LiveRun | null, now: number): OfficeRun {
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
    jobName: jobNameOf(r.jobName),
    health: r.health,
    phase: mine?.phase ?? null,
    model: p.model ?? null,
    turns: p.turns ?? 0,
    outputTokens: p.outputTokens ?? 0,
    contextTokens: p.contextTokens ?? 0,
    lastActivity: p.lastActivity ?? null,
    subagents: (Array.isArray(mine?.subagents) ? mine.subagents : []).map((a) => ({ id: a.id, description: a.description, type: a.type ?? null, activity: a.activity ?? null })),
    startedAt: r.startedAt ?? null,
    elapsedMs: elapsedSince(r.startedAt, now),
    agentPid: r.agentPid ?? null,
  };
}

function historyEntry(h: HistoryEntry): OfficeHistoryEntry {
  const durationMs = h.durationMs ?? (h.startedAt ? Date.parse(h.endedAt) - Date.parse(h.startedAt) : null);
  return {
    runId: h.runId,
    kind: h.kind ?? null,
    trigger: triggerOf(h.trigger),
    label: h.label ?? null,
    workspaceAlias: typeof h.workspaceAlias === 'string' ? h.workspaceAlias : null,
    inferredWorkspace: aliasOf(h.inferredWorkspace),
    parentRunId: typeof h.parentRunId === 'string' ? h.parentRunId : null,
    issueNumber: typeof h.issueNumber === 'number' ? h.issueNumber : null,
    room: roomOf(h.room),
    jobName: jobNameOf(h.jobName),
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

const manualPause = (p: ManualPause): OfficeManualPause => ({ reason: p.reason, pausedAt: p.pausedAt, until: p.until });

export function buildOfficeSnapshot({ status: d, live, workspaces, issues = null, jobs = [], sessions = [] }: {
    status: StatusSnapshot;
    live: LiveRun | null;
    workspaces: string[];
    issues?: OfficeIssues | null;
    jobs?: JobScheduleEntry[];
    sessions?: OfficeSession[];
  }): OfficeSnapshot {
  const active = d.active.map((r) => officeRun(r, live, d.now));
  const manual = d.manualPauses ?? [];
  const general = manual.find((p) => p.scope === ALL);
  const { today, week } = spend(d);
  const totals = (t: { n: number; cost: number; tokens: number }): SpendTotals => ({ runs: t.n, costUsd: t.cost, tokens: t.tokens });
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
      limit: d.usageLimit ? { resetsAt: d.usageLimit.until, message: usageLimitText(d) } : null,
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
          jobName: jobNameOf(d.lock.jobName),
          startedAt: d.lock.startedAt ?? null,
        }
      : null,
    history: d.history.map(historyEntry),
    spend: { today: totals(today), week: totals(week) },
    workspaces,
    issues,
    jobs,
    sessions: sessions.map((s) => ({ id: s.id, workspaceAlias: s.workspaceAlias, cwd: s.cwd, branch: s.branch, state: s.state, activity: s.activity, subagents: s.subagents, since: s.since, lastEntryAt: s.lastEntryAt })),
  };
}

/**
 * Read everything a snapshot needs and build it. The allowlist and the job schedule are config, so
 * a broken file shows as no workspaces or no jobs instead of failing the feed.
 */
export async function collectOfficeSnapshot({ statusSnapshot, liveRun, workspaceAliases, issues = () => null, jobs = async () => [], sessions = () => [] }: {
    statusSnapshot: () => Promise<StatusSnapshot>;
    liveRun: () => Promise<{ activeRun: LiveRun | null }>;
    workspaceAliases: () => Promise<string[]>;
    issues?: () => OfficeIssues | null;
    jobs?: () => Promise<JobScheduleEntry[]>;
    sessions?: () => OfficeSession[];
  }): Promise<OfficeSnapshot> {
  const [status, live, workspaces, schedule] = await Promise.all([
    statusSnapshot(),
    liveRun().then((s) => s.activeRun, () => null),
    workspaceAliases().catch(() => []),
    jobs().catch(() => []),
  ]);
  return buildOfficeSnapshot({ status, live, workspaces, issues: issues(), jobs: schedule, sessions: safely(sessions) });
}
