/**
 * Parses the raw WhatsApp text the bot forwards (`claude…`) into a runner command. Pure.
 * User-facing commands keep the `claude` prefix even though the runner itself is agent-neutral.
 *
 * @typedef {{ kind: 'freeform', prompt: string }
 *   | { kind: 'joplin', noteQuery: string }
 *   | { kind: 'stop' }
 *   | { kind: 'restart' }
 *   | { kind: 'error', message: string }} Command
 */

export const USAGE = `Usage:
claude <instructions>  run the agent in ~/Projects
claude joplin:<note title or id>  use a Joplin note as the instructions
claude:stop  kill the active run
claude:restart  safely restart agent-runner (refused while a run is active)`;

const SUBCOMMANDS = /** @type {const} */ (['stop', 'restart']);

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
  const sub = rest.match(/^:(\S+)(?:\s[\s\S]*)?$/);
  if (sub) {
    const name = sub[1].toLowerCase();
    if (/** @type {readonly string[]} */ (SUBCOMMANDS).includes(name)) {
      return { kind: /** @type {'stop' | 'restart'} */ (name) };
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
