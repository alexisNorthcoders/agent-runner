/**
 * The seam between the runner and a concrete coding agent. The runner only speaks these types;
 * agent-specific details (CLI flags, output parsing, skills) stay inside the implementation.
 * Claude Code is the only implementation.
 */

import { isRecord, numberOrNull, stringOrNull } from '../narrow.ts';
import { createClaudeBackend } from './claude.ts';

/** `limited`: the agent hit its usage limit, and `AgentResult.limit` says when it resets. */
export type AgentOutcome = 'success' | 'failed' | 'timeout' | 'stopped' | 'spawn_error' | 'limited';

/**
 * `resetsAt` (ISO) is when runs may start again, a small buffer past the reset. `note` is how the
 * agent put it (e.g. `resets 7am Europe/London`) and `timeZone` the zone it named, when known.
 */
export type AgentUsageLimit = { resetsAt: string; note: string | null; timeZone: string | null };

/** `subagents`: the subagents the agent has running now, oldest first (none when left out). */
export type AgentProgress = {
  model: string | null;
  turns: number;
  outputTokens: number;
  contextTokens: number;
  lastActivity: string | null;
  subagents?: AgentSubagent[];
};

/**
 * A subagent the agent spawned: its `description` (what the agent asked of it), its `type` (e.g.
 * `general-purpose`), and what it's doing now (`Bash: git diff`, `writing…`), null until it starts.
 */
export type AgentSubagent = { id: string; description: string; type: string | null; activity: string | null };

export type AgentTokens = { input: number; output: number; cacheRead: number; cacheCreate: number };

export type AgentResult = {
  outcome: AgentOutcome;
  exitCode: number | null;
  text: string;
  stderr: string;
  logPath: string;
  limit?: AgentUsageLimit;
  sessionMissing?: boolean;
  usage: {
    model: string | null;
    sessionId: string | null;
    turns: number;
    costUsd: number | null;
    tokens: AgentTokens;
  };
};

/**
 * A tool call that changes files or runs a command, and the absolute paths it works on (not
 * realpath'd): the file an edit writes, or the directory a command runs in and the paths it
 * targets. Reads and searches aren't touches.
 */
export type AgentTouch = { action: 'edit' | 'command'; paths: string[] };

/**
 * The model a run resolved and where it came from: asked for, the workspace's own agent
 * settings, or the runner default.
 */
export type AgentModelChoice = { name: string; source: 'prefix' | 'label' | 'parent' | 'workspace' | 'default' };

/**
 * `model` is the requested model; it beats the workspace's own agent settings. `modelSource`
 * says where the request came from (default `prefix`).
 * `implement` runs the agent's issue-implementation workflow (Claude: the `/implement` skill).
 * `resume` continues an earlier session's conversation in a session of its own: the earlier one
 * is left as it ended.
 * `onTouch` hears each edit or command, in order.
 */
export type AgentStartOptions = {
  prompt: string;
  preamble?: string;
  implement?: boolean;
  model?: string;
  modelSource?: 'prefix' | 'label' | 'parent';
  cwd: string;
  logPath: string;
  onProgress?: (p: AgentProgress) => void;
  onTouch?: (t: AgentTouch) => void;
  resume?: { sessionId: string };
};

/** `done` never rejects: failures come back as an outcome. */
export type AgentRun = { pid: number | null; model: AgentModelChoice; done: Promise<AgentResult>; stop: () => void };

/** `stopOrphan` stops an agent a dead runner left running, if the pid really is one; true once gone. */
export type AgentBackend = {
  name: string;
  start: (opts: AgentStartOptions) => Promise<AgentRun>;
  stopOrphan?: (pid: number) => Promise<boolean>;
};

function parseSubagent(v: unknown): AgentSubagent | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.description !== 'string') return null;
  return { id: v.id, description: v.description, type: stringOrNull(v.type), activity: stringOrNull(v.activity) };
}

/**
 * The well-typed `AgentProgress` fields of a value that was written as one (a run's active file),
 * dropping the rest. A malformed subagent is dropped from `subagents`.
 */
export function parseAgentProgress(v: unknown): Partial<AgentProgress> {
  if (!isRecord(v)) return {};
  const p: Partial<AgentProgress> = {};
  for (const k of ['model', 'lastActivity'] as const) {
    if (typeof v[k] === 'string' || v[k] === null) p[k] = stringOrNull(v[k]);
  }
  for (const k of ['turns', 'outputTokens', 'contextTokens'] as const) {
    const n = numberOrNull(v[k]);
    if (n !== null) p[k] = n;
  }
  if (Array.isArray(v.subagents)) p.subagents = v.subagents.map(parseSubagent).filter((a) => a !== null);
  return p;
}

export function createAgentBackend({ timeoutMs }: { timeoutMs: number }): AgentBackend {
  return createClaudeBackend({ timeoutMs });
}
