import { createClaudeBackend } from './claude.js';

/**
 * The seam between the runner and a concrete coding agent. The runner only speaks these types;
 * agent-specific details (CLI flags, output parsing, skills) stay inside the implementation.
 * Claude Code is the only implementation.
 *
 * @typedef {'success' | 'failed' | 'timeout' | 'stopped' | 'spawn_error' | 'limited'} AgentOutcome
 *   `limited`: the agent hit its usage limit, and `AgentResult.limit` says when it resets.
 *
 * @typedef {{ resetsAt: string, note: string | null, timeZone: string | null }} AgentUsageLimit
 *   `resetsAt` (ISO) is when runs may start again, a small buffer past the reset. `note` is how the
 *   agent put it (e.g. `resets 7am Europe/London`) and `timeZone` the zone it named, when known.
 *
 * @typedef {{
 *   model: string | null,
 *   turns: number,
 *   outputTokens: number,
 *   contextTokens: number,
 *   lastActivity: string | null,
 * }} AgentProgress
 *
 * @typedef {{
 *   outcome: AgentOutcome,
 *   exitCode: number | null,
 *   text: string,
 *   stderr: string,
 *   logPath: string,
 *   limit?: AgentUsageLimit,
 *   usage: {
 *     model: string | null,
 *     sessionId: string | null,
 *     turns: number,
 *     costUsd: number | null,
 *     tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   },
 * }} AgentResult
 *
 * @typedef {{ action: 'edit' | 'command', paths: string[] }} AgentTouch
 *   A tool call that changes files or runs a command, and the absolute paths it works on (not
 *   realpath'd): the file an edit writes, or the directory a command runs in and the paths it
 *   targets. Reads and searches aren't touches.
 *
 * @typedef {{ name: string, source: 'prefix' | 'workspace' | 'default' }} AgentModelChoice
 *   The model a run resolved and where it came from: asked for, the workspace's own agent
 *   settings, or the runner default.
 *
 * @typedef {{
 *   prompt: string,
 *   preamble?: string,
 *   implement?: boolean,
 *   model?: string,
 *   cwd: string,
 *   logPath: string,
 *   onProgress?: (p: AgentProgress) => void,
 *   onTouch?: (t: AgentTouch) => void,
 * }} AgentStartOptions
 *   `model` is the requested model; it beats the workspace's own agent settings.
 *   `implement` runs the agent's issue-implementation workflow (Claude: the `/implement` skill).
 *   `onTouch` hears each edit or command, in order.
 *
 * @typedef {{ pid: number | null, model: AgentModelChoice, done: Promise<AgentResult>, stop: () => void }} AgentRun
 *   `done` never rejects: failures come back as an outcome.
 *
 * @typedef {{
 *   name: string,
 *   start: (opts: AgentStartOptions) => Promise<AgentRun>,
 *   stopOrphan?: (pid: number) => Promise<boolean>,
 * }} AgentBackend
 *   `stopOrphan` stops an agent a dead runner left running, if the pid really is one; true once gone.
 */

/**
 * @param {{ timeoutMs: number }} p
 * @returns {AgentBackend}
 */
export function createAgentBackend({ timeoutMs }) {
  return createClaudeBackend({ timeoutMs });
}
