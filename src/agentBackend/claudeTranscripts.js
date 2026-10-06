import { readdir, readFile, readlink } from 'fs/promises';
import { describeToolUse } from './claudeStreamParser.js';

/**
 * Reads Claude Code's session transcripts (`~/.claude/projects/<folder>/<session-id>.jsonl`, one
 * JSON entry per line) to tell what an interactive session is doing. The format is Claude Code's
 * own, not a documented interface, so this relies only on: `type` (`user` / `assistant`),
 * `timestamp`, `sessionId`, `cwd`, `gitBranch`, `entrypoint` (`cli` is interactive, `sdk-cli` a
 * headless run), `isSidechain` (a subagent's entry) and `message.content[]` (`thinking`, `text`,
 * `tool_use` and `tool_result` blocks). A line that doesn't parse or lacks them is skipped.
 *
 * Only those fields are kept: never the text of a prompt or a reply.
 */

/** A subagent that has written nothing for this long no longer counts as running. */
export const SUBAGENT_RECENT_MS = 3 * 60_000;

/**
 * @typedef {{
 *   sessionId: string | null,
 *   cwd: string | null,
 *   branch: string | null,
 *   lastEntryAt: number | null,
 *   interactive: boolean | null,
 *   state: 'working' | 'waiting' | null,
 *   activity: string | null,
 *   sidechains: Map<string, number>,
 * }} TranscriptState
 *   `interactive`: null until an entry says (`entrypoint`). `state` is null until a main-thread
 *   entry shows it. `activity`: the last main-thread tool call, or `writing…`. `sidechains`: when
 *   each subagent last wrote (epoch ms), by agent id.
 */

/** @returns {TranscriptState} */
export function emptyTranscript() {
  return { sessionId: null, cwd: null, branch: null, lastEntryAt: null, interactive: null, state: null, activity: null, sidechains: new Map() };
}

/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * What a main-thread entry says about the session, from its last content block.
 * @param {Record<string, any>} entry
 * @returns {{ state: 'working' | 'waiting', activity?: string | null } | null}
 */
function mainThreadEffect(entry) {
  const content = entry.message?.content;
  if (entry.type === 'user') {
    // a tool_result keeps the activity of the call it answers; a prompt starts new work
    const result = Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
    return result ? { state: 'working' } : { state: 'working', activity: 'writing…' };
  }
  if (entry.type !== 'assistant' || !Array.isArray(content)) return null;
  const last = [...content].reverse().find((b) => b && typeof b === 'object' && ['tool_use', 'thinking', 'text'].includes(b.type));
  if (!last) return null;
  if (last.type === 'tool_use') return { state: 'working', activity: describeToolUse(String(last.name ?? 'tool'), last.input && typeof last.input === 'object' ? last.input : {}) };
  if (last.type === 'thinking') return { state: 'working', activity: 'writing…' };
  return { state: 'waiting' };
}

/**
 * Fold the lines a transcript gained into its state. Never throws.
 * @param {TranscriptState} state mutated
 * @param {string[]} lines
 * @returns {TranscriptState}
 */
export function applyTranscriptLines(state, lines) {
  for (const line of lines) {
    /** @type {any} */
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    state.sessionId = str(entry.sessionId) ?? state.sessionId;
    state.cwd = str(entry.cwd) ?? state.cwd;
    state.branch = str(entry.gitBranch) ?? state.branch;
    if (typeof entry.entrypoint === 'string') state.interactive = entry.entrypoint === 'cli';
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(at)) state.lastEntryAt = Math.max(state.lastEntryAt ?? 0, at);
    if (entry.isSidechain === true) {
      state.sidechains.set(str(entry.agentId) ?? 'subagent', Number.isFinite(at) ? at : (state.lastEntryAt ?? 0));
      continue;
    }
    const effect = mainThreadEffect(entry);
    if (!effect) continue;
    state.state = effect.state;
    if (effect.activity !== undefined) state.activity = effect.activity;
  }
  return state;
}

/**
 * The subagents running at `now`: those that wrote within SUBAGENT_RECENT_MS, and none while the
 * session waits for the owner. Best effort.
 * @param {TranscriptState} state @param {number} now
 */
export function subagentCount(state, now) {
  if (state.state === 'waiting') return 0;
  let n = 0;
  for (const [id, at] of state.sidechains) {
    if (now - at <= SUBAGENT_RECENT_MS) n++;
    else state.sidechains.delete(id);
  }
  return n;
}

/**
 * The working directories of the running `claude` processes, from `/proc` (Linux): every
 * `/proc/<pid>` whose `comm` is `claude`, by its `cwd` link. A process that goes away mid-read is skipped.
 * @param {string} [proc]
 * @returns {Promise<string[]>}
 */
export async function listClaudeCwds(proc = '/proc') {
  const cwds = [];
  for (const pid of (await readdir(proc)).filter((n) => /^\d+$/.test(n))) {
    try {
      if ((await readFile(`${proc}/${pid}/comm`, 'utf8')).trim() !== 'claude') continue;
      cwds.push(await readlink(`${proc}/${pid}/cwd`));
    } catch {
      /* gone, or not ours to read */
    }
  }
  return cwds;
}
