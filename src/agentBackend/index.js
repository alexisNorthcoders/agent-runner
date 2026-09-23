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
 * @typedef {{
 *   prompt: string,
 *   preamble?: string,
 *   implement?: boolean,
 *   cwd: string,
 *   logPath: string,
 *   onProgress?: (p: AgentProgress) => void,
 * }} AgentStartOptions
 *   `implement` runs the agent's issue-implementation workflow (Claude: the `/implement` skill).
 *
 * @typedef {{ pid: number | null, done: Promise<AgentResult>, stop: () => void }} AgentRun
 *   `done` never rejects: failures come back as an outcome.
 *
 * @typedef {{ name: string, start: (opts: AgentStartOptions) => Promise<AgentRun> }} AgentBackend
 */

/**
 * @param {{ timeoutMs: number }} p
 * @returns {AgentBackend}
 */
export function createAgentBackend({ timeoutMs }) {
  return createClaudeBackend({ timeoutMs });
}
