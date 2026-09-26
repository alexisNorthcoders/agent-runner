import { createClaudeBackend } from './claude.js';

/**
 * The seam between the runner and a concrete coding agent. The runner only speaks these types;
 * agent-specific details (CLI flags, output parsing, skills) stay inside the implementation.
 * Claude Code is the only implementation.
 *
 * @typedef {'success' | 'failed' | 'timeout' | 'stopped' | 'spawn_error'} AgentOutcome
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
 * @typedef {{
 *   prompt: string,
 *   preamble?: string,
 *   implement?: boolean,
 *   cwd: string,
 *   logPath: string,
 *   onProgress?: (p: AgentProgress) => void,
 *   onTouch?: (t: AgentTouch) => void,
 * }} AgentStartOptions
 *   `implement` runs the agent's issue-implementation workflow (Claude: the `/implement` skill).
 *   `onTouch` hears each edit or command, in order.
 *
 * @typedef {{ pid: number | null, done: Promise<AgentResult>, stop: () => void }} AgentRun
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
