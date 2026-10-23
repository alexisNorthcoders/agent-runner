/**
 * The office snapshot: what the office feed (src/officeFeed.ts) sends to the dashboard. It is the
 * status snapshot `agent:status` renders (src/statusCollect.ts), plus the live phase and progress
 * this process holds in memory, reshaped into an explicit contract for the page. Every later
 * dashboard feature builds on this shape, so change it by adding fields, and bump `version` on a
 * breaking change. The snapshot is built by src/officeSnapshot.ts.
 *
 * The page is served on the LAN, so the snapshot carries no paths (log, workspace), reply
 * addresses or prompts: runs are named by their label, and workspaces by their alias.
 *
 * Types only, with no imports: the dashboard's checkJs project loads this file, and anything it
 * imported would bring Node's globals into browser code.
 */

/**
 * `running`: the runner process that owns it is alive. `orphaned`: the runner died but the agent
 * process is still going, so nobody will report its result. `stale`: both are gone.
 */
export type RunHealth = 'running' | 'orphaned' | 'stale';

/** `cron`: the cron issue tracer. `schedule`: a scheduled job. `manual`: WhatsApp or HTTP. */
export type RunTrigger = 'manual' | 'cron' | 'schedule';

export type CronTickOutcome = {
  kind: 'busy' | 'paused' | 'limited' | 'no_eligible' | 'ran' | 'error' | string;
  repo?: string;
  issue?: number;
  result?: string;
  note?: string;
};

export type OfficeIssue = { number: number; title: string; url: string };

export type OfficeParkedIssue = OfficeIssue & { prUrl: string };

/**
 * One workspace's repo. `scannedAt`: when this data was read (null if it never has been).
 * `stale`: the latest scan of it failed, so this is older data. `runnable`, `blocked` and
 * `parked` are its `ready-for-agent` issues, and `parked` carries the open PR's link.
 */
export type OfficeIssueRepo = {
  alias: string;
  repo: string | null;
  scannedAt: string | null;
  stale: boolean;
  runnable: OfficeIssue[];
  blocked: OfficeIssue[];
  parked: OfficeParkedIssue[];
  readyForHuman: OfficeIssue[];
  needsTriage: number;
  needsInfo: number;
};

/** `scannedAt`: when the latest scan ended. `repos`: in the allowlist's (alias) order. */
export type OfficeIssues = { scannedAt: string; repos: OfficeIssueRepo[] };

/** A configured job, for the office: no command, directory or env. */
export type JobScheduleEntry = { name: string; room: string; at: string; nextDueAt: string };

/** `since`: when the watch first saw it open. `lastEntryAt`: its latest transcript entry. */
export type OfficeSession = {
  id: string;
  workspaceAlias: string | null;
  cwd: string;
  branch: string | null;
  state: 'working' | 'waiting';
  activity: string | null;
  subagents: number;
  since: string;
  lastEntryAt: string;
};

/**
 * An in-flight run. `trigger` is `cron` for the cron issue tracer, `schedule` for a scheduled
 * job (`kind: job`, with its `room` and `jobName`), else `manual` (WhatsApp or HTTP). `inferredWorkspace`: the
 * allowlisted workspace a freeform run turned out to work in, once its first edit or command
 * there is seen (null until then, and for other kinds). A job's phase is `job`. `phase` is known only for the run this process is executing (null for an orphaned or
 * stale one). `elapsedMs` is as of the snapshot's `at`. `subagents`: the subagents the
 * agent has running now, oldest first (only for the run this process is executing).
 */
export type OfficeRun = {
  runId: string;
  kind: string | null;
  trigger: RunTrigger;
  label: string | null;
  workspaceAlias: string | null;
  inferredWorkspace: string | null;
  issueNumber: number | null;
  room: string | null;
  jobName: string | null;
  health: RunHealth;
  phase: 'agent' | 'post-run' | 'job' | null;
  model: string | null;
  turns: number;
  outputTokens: number;
  contextTokens: number;
  lastActivity: string | null;
  subagents: Array<{ id: string; description: string; type: string | null; activity: string | null }>;
  startedAt: string | null;
  elapsedMs: number | null;
  agentPid: number | null;
};

/**
 * A finished run. `outcome` is the agent's (`success`, `failed`, `timeout`, `stopped`,
 * `spawn_error`), or `interrupted` for a run a restart cut off; `result` is an issue run's
 * pipeline result (`merged`, `pr_open`, `pushed`, `no_changes`, …), and `prUrl` its PR's.
 * `tokens` is the total over input, output and cache. `inferredWorkspace`: as on `OfficeRun`.
 * `parentRunId`: the run a `claude:more` continued (additive, no version bump).
 */
export type OfficeHistoryEntry = {
  runId: string;
  kind: string | null;
  trigger: RunTrigger;
  label: string | null;
  workspaceAlias: string | null;
  inferredWorkspace: string | null;
  parentRunId: string | null;
  issueNumber: number | null;
  room: string | null;
  jobName: string | null;
  startedAt: string | null;
  endedAt: string;
  durationMs: number | null;
  outcome: string;
  result: string | null;
  prUrl: string | null;
  model: string | null;
  turns: number;
  costUsd: number | null;
  tokens: number;
};

export type SpendTotals = { runs: number; costUsd: number; tokens: number };

export type OfficeManualPause = { reason: string; pausedAt: string; until: string };

/**
 * `restart` is the safe-restart pause flag (`unknown` when Redis couldn't be read). `general` and
 * `workspaces` are the owner's pauses by hand. `limit` is the usage-limit pause: when the limit
 * resets, and the line `agent:status` shows for it (e.g. `usage limit hit, until 07:02 (resets
 * 7am Europe/London)`, in the zone the agent named).
 */
export type OfficePauses = {
  restart: { reason: string; pausedAt: string | null } | null | 'unknown';
  general: OfficeManualPause | null;
  workspaces: Array<OfficeManualPause & { alias: string }>;
  limit: { resetsAt: string; message: string } | null;
};

/**
 * `nextTickAt` is the last tick's start plus the interval, as `agent:status` predicts it (null
 * before the first tick or while the cron's process is gone).
 */
export type OfficeCron = {
  alive: boolean;
  pid: number;
  intervalMs: number;
  lastTickStartedAt: string | null;
  lastTickEndedAt: string | null;
  outcome: CronTickOutcome | null;
  nextTickAt: string | null;
};

export type OfficeLock = {
  runId: string;
  kind: string | null;
  trigger: RunTrigger;
  label: string | null;
  workspaceAlias: string | null;
  inferredWorkspace: string | null;
  issueNumber: number | null;
  room: string | null;
  jobName: string | null;
  startedAt: string | null;
};

/**
 * `at`: when the snapshot was taken (ISO). `activeRun`: the run this runner is executing, if any.
 * `active`: every in-flight run `agent:status` lists, including orphaned and stale ones, oldest
 * first. `queue`: oldest first. `history`: the last 7 days, newest first. `spend`: today (since
 * local midnight) and the last 7 days. `workspaces`: the allowlisted aliases, sorted. `issues`:
 * the issue scan's latest result (src/issueScan.ts), null before its first scan ends. `jobs`: the
 * scheduled jobs' config (src/scheduledJobs.ts) with each one's next due time, in config order.
 * `sessions`: the interactive agent sessions open on the machine (src/sessionWatch.ts), oldest
 * first, with the allowlisted workspace each is in (null outside any); `[]` when the watch is off
 * or fails. They carry no prompt or reply text.
 */
export type OfficeSnapshot = {
  version: 1;
  at: string;
  activeRun: OfficeRun | null;
  active: OfficeRun[];
  queue: Array<{ id: string; kind: string; label: string; queuedAt: string }>;
  pauses: OfficePauses;
  cron: OfficeCron | null;
  lock: OfficeLock | null;
  history: OfficeHistoryEntry[];
  spend: { today: SpendTotals; week: SpendTotals };
  workspaces: string[];
  issues: OfficeIssues | null;
  jobs: JobScheduleEntry[];
  sessions: OfficeSession[];
};
