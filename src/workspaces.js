import { readFile, realpath, stat } from 'fs/promises';
import { resolve as pathResolve } from 'path';

/**
 * The workspace allowlist for issue runs: the only repos an issue run may branch, commit and push
 * in. It's a security boundary, so every configured path is canonicalized with realpath and a
 * missing or non-directory path fails the run instead of being skipped. Freeform runs don't use it.
 *
 * Config (the bot's variable names, so its `.env` lines can be copied over):
 * - `CLAUDE_WORKSPACE_MAP`: `alias=/abs/path,other=/abs/path`
 * - `CLAUDE_WORKSPACE_MAP_FILE`: a JSON object `{ "alias": "/abs/path" }`, which wins over the env map
 * - `CLAUDE_ISSUE_DEFAULT_ALIAS`: the alias `claude issue:<n>` uses when no alias is given
 */

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * @param {string | undefined} str `alias=value,alias=value`
 * @returns {Map<string, string>}
 */
export function parseCompactMap(str) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const segment of String(str || '').split(',')) {
    const p = segment.trim();
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    const val = p.slice(eq + 1).trim();
    if (ALIAS_RE.test(key) && val) out.set(key, val);
  }
  return out;
}

/** @param {string} rawPath @returns {Promise<string>} canonical realpath of a directory */
async function canonicalDir(rawPath) {
  let rp;
  try {
    rp = await realpath(pathResolve(rawPath));
  } catch (e) {
    throw new Error(`Path does not exist or is not reachable: ${rawPath} (${e.message || e})`);
  }
  if (!(await stat(rp)).isDirectory()) throw new Error(`Not a directory: ${rp}`);
  return rp;
}

/** @param {string} file @returns {Promise<Map<string, string>>} */
async function loadMapFile(file) {
  const resolved = pathResolve(file);
  let raw;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (e) {
    throw new Error(`CLAUDE_WORKSPACE_MAP_FILE: cannot read ${resolved}: ${e.message || e}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CLAUDE_WORKSPACE_MAP_FILE: invalid JSON (${e.message || e})`);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.trim() && ALIAS_RE.test(k)) out.set(k, v.trim());
    }
  }
  return out;
}

/**
 * The config is re-read on every lookup (it's a couple of stat calls), so an edited map file
 * applies without a restart.
 * @param {{ env?: Record<string, string | undefined> }} [p]
 */
export function createWorkspaceAllowlist({ env = process.env } = {}) {
  /** @returns {Promise<Map<string, string>>} alias → configured (not yet canonical) path */
  async function configuredAliases() {
    const file = env.CLAUDE_WORKSPACE_MAP_FILE?.trim();
    return new Map([...parseCompactMap(env.CLAUDE_WORKSPACE_MAP), ...(file ? await loadMapFile(file) : [])]);
  }

  return {
    /**
     * @param {string | null} alias null → `CLAUDE_ISSUE_DEFAULT_ALIAS`
     * @returns {Promise<{ alias: string, root: string }>}
     */
    async resolveIssueWorkspace(alias) {
      const aliases = await configuredAliases();
      const wanted = alias ?? env.CLAUDE_ISSUE_DEFAULT_ALIAS?.trim() ?? '';
      const valid = [...aliases.keys()].sort().join(', ') || '(none: set CLAUDE_WORKSPACE_MAP)';
      if (!wanted) {
        throw new Error(`Say which workspace: claude issue:<alias>:<n>, or set CLAUDE_ISSUE_DEFAULT_ALIAS. Valid aliases: ${valid}`);
      }
      const raw = aliases.get(wanted);
      if (!raw) throw new Error(`Unknown workspace alias "${wanted}". Valid aliases: ${valid}`);
      return { alias: wanted, root: await canonicalDir(raw) };
    },
  };
}
