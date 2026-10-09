import { ALL, DEFAULT_MANUAL_PAUSE_SECONDS, MAX_MANUAL_PAUSE_SECONDS, parseDuration } from './manualPause.js';

/**
 * Parses the raw WhatsApp text the bot forwards (`claude…`) into a runner command. Pure.
 * User-facing commands keep the `claude` prefix even though the runner itself is agent-neutral.
 *
 * @typedef {{ kind: 'freeform', prompt: string, model?: string }
 *   | { kind: 'joplin', noteQuery: string, model?: string }
 *   | { kind: 'more', instructions: string }
 *   | { kind: 'issue', issueNumber: number, alias: string | null, extraInstructions: string }
 *   | { kind: 'stop' }
 *   | { kind: 'restart' }
 *   | { kind: 'status' }
 *   | { kind: 'history', count: number }
 *   | { kind: 'queue', clear: boolean }
 *   | PauseCommand
 *   | { kind: 'error', message: string }} Command
 *
 * @typedef {{ kind: 'pause', scope: string, seconds: number, reason: string }
 *   | { kind: 'resume', scope: string | null }} PauseCommand
 *   `scope` is `all` or a workspace alias; a resume with no scope clears every pause.
 */

export const USAGE = `Usage:
claude <instructions>  run the agent in ~/Projects
claude joplin:<note title or id>  use a Joplin note as the instructions
claude haiku|sonnet|opus: <instructions or joplin:<note>>  the same, on that model (not for issue runs: they use the issue's label)
claude issue:<alias>:<n> [extra instructions]  implement GitHub issue <n> in the <alias> workspace, then PR, review and merge
claude issue:<n> [extra instructions]  the same, in the default issue workspace
claude:more <instructions>  continue the newest freeform or Joplin run: it resumes that run's conversation
claude:stop  kill the active run (queued requests still run)
claude:queue  list the requests waiting for the agent
claude:queue clear  drop every waiting request
claude:pause [<alias>] [2h] [reason]  stop new agent runs (everything, or only issue runs in <alias>) for a while (default 2h)
claude:resume [<alias>]  end a pause early (no alias: every pause, the usage limit's too)
claude:restart  safely restart agent-runner (refused while a run is active)
claude:status  active run, pause, last cron tick and recent runs
claude:history [n]  the last n finished runs with cost and tokens`;

const MODEL_PREFIX_USAGE = 'Usage: claude haiku|sonnet|opus: <instructions or joplin:<note>>';

const MORE_USAGE = 'Usage: claude:more <instructions>  (continues the newest freeform or Joplin run)';

const SUBCOMMANDS = /** @type {const} */ (['stop', 'restart', 'status']);

export const DEFAULT_HISTORY_COUNT = 10;
export const MAX_HISTORY_COUNT = 30;
const HISTORY_USAGE = `Usage: claude:history [n]  (n = number of runs, 1-${MAX_HISTORY_COUNT})`;
export const PAUSE_USAGE = 'Usage: claude:pause [<alias>] [duration] [reason]  (duration like 30m, 2h, 1d; up to 7d; default 2h)\n       claude:resume [<alias>]';

/**
 * The words after `pause` / `resume`, shared with the `agent:pause` CLI.
 * `pause [<alias>|all] [<duration>] [reason…]`: a leading duration means the general pause.
 * @param {'pause' | 'resume'} verb
 * @param {string[]} words
 * @returns {PauseCommand | { kind: 'error', message: string }}
 */
export function parsePauseArgs(verb, words) {
  const w = words.filter(Boolean);
  if (verb === 'resume') {
    if (w.length > 1) return { kind: 'error', message: PAUSE_USAGE };
    return { kind: 'resume', scope: w[0] ? w[0].toLowerCase() : null };
  }
  let scope = ALL;
  if (w.length && parseDuration(w[0]) == null) scope = /** @type {string} */ (w.shift()).toLowerCase();
  let seconds = DEFAULT_MANUAL_PAUSE_SECONDS;
  if (w.length && parseDuration(w[0]) != null) seconds = /** @type {number} */ (parseDuration(/** @type {string} */ (w.shift())));
  if (seconds > MAX_MANUAL_PAUSE_SECONDS) return { kind: 'error', message: PAUSE_USAGE };
  return { kind: 'pause', scope, seconds, reason: w.join(' ') };
}

/**
 * @param {string} text
 * @returns {Command}
 */
export function parseCommand(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  const m = trimmed.match(/^claude(?=$|[\s:])(.*)$/is);
  if (!m) return { kind: 'error', message: `Not a claude command.\n\n${USAGE}` };
  const rest = m[1];

  // `claude:<word>` (no space after the colon) is always a subcommand; trailing words are ignored,
  // so `claude:stop now` can never start a run with the prompt "stop now".
  const sub = rest.match(/^:(\S+)(?:\s([\s\S]*))?$/);
  if (sub) {
    const name = sub[1].toLowerCase();
    if (/** @type {readonly string[]} */ (SUBCOMMANDS).includes(name)) {
      return { kind: /** @type {'stop' | 'restart' | 'status'} */ (name) };
    }
    if (name === 'more') {
      const instructions = (sub[2] ?? '').trim();
      return instructions ? { kind: 'more', instructions } : { kind: 'error', message: MORE_USAGE };
    }
    if (name === 'history') {
      const arg = (sub[2] ?? '').trim().split(/\s+/)[0];
      if (!arg) return { kind: 'history', count: DEFAULT_HISTORY_COUNT };
      if (!/^\d+$/.test(arg) || parseInt(arg, 10) < 1) return { kind: 'error', message: HISTORY_USAGE };
      return { kind: 'history', count: Math.min(parseInt(arg, 10), MAX_HISTORY_COUNT) };
    }
    if (name === 'pause' || name === 'resume') return parsePauseArgs(name, (sub[2] ?? '').trim().split(/\s+/));
    if (name === 'queue') {
      const arg = (sub[2] ?? '').trim().toLowerCase();
      if (!arg) return { kind: 'queue', clear: false };
      if (arg === 'clear') return { kind: 'queue', clear: true };
      return { kind: 'error', message: 'Usage: claude:queue [clear]' };
    }
    return { kind: 'error', message: `Unknown command "claude:${sub[1]}".\n\n${USAGE}` };
  }

  const body = rest.replace(/^:/, '').trim();
  if (!body) return { kind: 'error', message: USAGE };

  const prefix = body.match(/^(haiku|sonnet|opus)\s*:\s*([\s\S]*)$/i);
  const model = prefix ? prefix[1].toLowerCase() : null;
  const task = prefix ? prefix[2].trim() : body;
  if (prefix) {
    if (!task) return { kind: 'error', message: MODEL_PREFIX_USAGE };
    if (/^issue:/i.test(task)) return { kind: 'error', message: `A model prefix doesn't apply to issue runs: they use the model from the issue's label.\n\n${MODEL_PREFIX_USAGE}` };
  }
  const withModel = model ? { model } : {};

  const joplin = task.match(/^joplin:(.*)$/is);
  if (joplin) {
    const noteQuery = joplin[1].trim();
    if (!noteQuery) return { kind: 'error', message: 'Usage: claude joplin:<note title or id>' };
    return { kind: 'joplin', noteQuery, ...withModel };
  }

  if (/^issue:/i.test(body)) {
    const m = body.match(/^issue:\s*(?:([a-zA-Z0-9_-]+)\s*:\s*)?(\d+)(?=$|\s)\s*([\s\S]*)$/i);
    const issueNumber = m ? parseInt(m[2], 10) : 0;
    if (!m || issueNumber < 1) {
      return { kind: 'error', message: 'Usage: claude issue:<n> or claude issue:<alias>:<n> [extra instructions]' };
    }
    return { kind: 'issue', issueNumber, alias: m[1] ?? null, extraInstructions: m[3].trim() };
  }

  return { kind: 'freeform', prompt: task, ...withModel };
}
