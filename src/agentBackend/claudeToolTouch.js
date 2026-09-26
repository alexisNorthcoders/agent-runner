import { homedir } from 'os';
import { isAbsolute, resolve } from 'path';

/**
 * Which paths a Claude tool call works on, as the agent-neutral `AgentTouch` the runner infers a
 * freeform run's workspace from (see ./index.js). Edits name their file; a Bash command touches
 * the directory it runs in and the paths it targets. Reads and searches touch nothing.
 *
 * The Bash tool keeps its working directory between calls, so the reader follows `cd` from one
 * command to the next. It reads the command as words, not as a shell would: a path it misses only
 * means the run is placed a little later, or stays in the Annex.
 */

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
/** Options whose next word is a directory the command works in (`git -C`, `npm --prefix`). */
const DIR_OPTIONS = new Set(['-C', '--prefix', '--cwd', '--dir']);
const GLOB = /[*?[{]/;

/** `~`, `~/x`, `$HOME/x` and `${HOME}/x` expanded; other words as they are. @param {string} w @param {string} home */
function expandHome(w, home) {
  if (w === '~' || w === '$HOME' || w === '${HOME}') return home;
  const m = /^(?:~|\$HOME|\$\{HOME\})\/(.*)$/.exec(w);
  return m ? `${home}/${m[1]}` : w;
}

/** A word's path up to its first glob character (`src/*.js` → `src/`). @param {string} w */
const beforeGlob = (w) => {
  const i = w.search(GLOB);
  return i < 0 ? w : w.slice(0, i);
};

/**
 * The command's simple commands, each as its words, quotes dropped.
 * @param {string} command
 * @returns {string[][]}
 */
export function splitCommand(command) {
  return String(command)
    .split(/&&|\|\||[;|\n()]/)
    .map((part) =>
      part
        .split(/[\s<>]+/)
        .map((w) => w.replace(/^['"]+|['"]+$/g, ''))
        .filter(Boolean)
    )
    .filter((words) => words.length);
}

/**
 * @param {{ cwd: string, home?: string }} p `cwd`: where the agent was started, the Bash tool's
 *   first working directory.
 */
export function createToolTouchReader({ cwd, home = homedir() }) {
  let shellCwd = cwd;
  /** @param {string} w @param {string} from */
  const pathOf = (w, from) => resolve(from, expandHome(beforeGlob(w), home) || '.');

  /** @param {string} command @returns {string[]} */
  function commandPaths(command) {
    const paths = [shellCwd];
    let here = shellCwd;
    for (const words of splitCommand(command)) {
      if (words[0] === 'cd') {
        const target = words[1];
        if (target !== '-') here = target ? pathOf(target, here) : home;
        paths.push(here);
        continue;
      }
      words.forEach((w, i) => {
        const value = w.startsWith('--') && w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
        const expanded = expandHome(value, home);
        if (isAbsolute(expanded)) paths.push(pathOf(value, here));
        else if (i > 0 && DIR_OPTIONS.has(words[i - 1])) paths.push(pathOf(value, here));
      });
    }
    // the tool's working directory follows a `cd` into the next call
    shellCwd = here;
    return [...new Set(paths)];
  }

  return {
    /**
     * @param {string} name the tool
     * @param {Record<string, unknown>} [input]
     * @returns {import('./index.js').AgentTouch | null}
     */
    read(name, input = {}) {
      if (EDIT_TOOLS.has(name)) {
        const file = input.file_path ?? input.notebook_path;
        return typeof file === 'string' && file ? { action: 'edit', paths: [pathOf(file, shellCwd)] } : null;
      }
      if (name === 'Bash' && typeof input.command === 'string') return { action: 'command', paths: commandPaths(input.command) };
      return null;
    },
  };
}
