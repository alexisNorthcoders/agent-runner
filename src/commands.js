/**
 * Parses the raw WhatsApp text the bot forwards (`claude…`) into a runner command. Pure.
 * User-facing commands keep the `claude` prefix even though the runner itself is agent-neutral.
 *
 * @typedef {{ kind: 'freeform', prompt: string }
 *   | { kind: 'joplin', noteQuery: string }
 *   | { kind: 'stop' }
 *   | { kind: 'restart' }
 *   | { kind: 'status' }
 *   | { kind: 'history', count: number }
 *   | { kind: 'error', message: string }} Command
 */

export const USAGE = `Usage:
claude <instructions>  run the agent in ~/Projects
claude joplin:<note title or id>  use a Joplin note as the instructions
claude:stop  kill the active run
claude:restart  safely restart agent-runner (refused while a run is active)
claude:status  active run, pause, last cron tick and recent runs
claude:history [n]  the last n finished runs with cost and tokens`;

const SUBCOMMANDS = /** @type {const} */ (['stop', 'restart', 'status']);

export const DEFAULT_HISTORY_COUNT = 10;
export const MAX_HISTORY_COUNT = 30;
const HISTORY_USAGE = `Usage: claude:history [n]  (n = number of runs, 1-${MAX_HISTORY_COUNT})`;

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
    if (name === 'history') {
      const arg = (sub[2] ?? '').trim().split(/\s+/)[0];
      if (!arg) return { kind: 'history', count: DEFAULT_HISTORY_COUNT };
      if (!/^\d+$/.test(arg) || parseInt(arg, 10) < 1) return { kind: 'error', message: HISTORY_USAGE };
      return { kind: 'history', count: Math.min(parseInt(arg, 10), MAX_HISTORY_COUNT) };
    }
    return { kind: 'error', message: `Unknown command "claude:${sub[1]}".\n\n${USAGE}` };
  }

  const body = rest.replace(/^:/, '').trim();
  if (!body) return { kind: 'error', message: USAGE };

  const joplin = body.match(/^joplin:(.*)$/is);
  if (joplin) {
    const noteQuery = joplin[1].trim();
    if (!noteQuery) return { kind: 'error', message: 'Usage: claude joplin:<note title or id>' };
    return { kind: 'joplin', noteQuery };
  }

  if (/^issue:/i.test(body)) {
    return { kind: 'error', message: 'claude issue:<n> is not supported by agent-runner yet.' };
  }

  return { kind: 'freeform', prompt: body };
}
