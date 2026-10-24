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

import { readFile, realpath, stat } from 'fs/promises';
import { resolve as pathResolve } from 'path';
import { errorText, isRecord } from './narrow.ts';

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

/** Parses `alias=value,alias=value`. Entries without a valid alias or a value are skipped. */
export function parseCompactMap(str: string | undefined): Map<string, string> {
  const out: Map<string, string> = new Map();
  for (const segment of (str ?? '').split(',')) {
    const p = segment.trim();
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    const key = p.slice(0, eq).trim();
    const val = p.slice(eq + 1).trim();
    if (ALIAS_RE.test(key) && val) out.set(key, val);
  }
  return out;
}

/** The canonical realpath of a directory. Throws when the path is missing or not a directory. */
async function canonicalDir(rawPath: string): Promise<string> {
  let rp;
  try {
    rp = await realpath(pathResolve(rawPath));
  } catch (e) {
    throw new Error(`Path does not exist or is not reachable: ${rawPath} (${errorText(e)})`);
  }
  if (!(await stat(rp)).isDirectory()) throw new Error(`Not a directory: ${rp}`);
  return rp;
}

async function loadMapFile(file: string): Promise<Map<string, string>> {
  const resolved = pathResolve(file);
  let raw;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (e) {
    throw new Error(`CLAUDE_WORKSPACE_MAP_FILE: cannot read ${resolved}: ${errorText(e)}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`CLAUDE_WORKSPACE_MAP_FILE: invalid JSON (${errorText(e)})`);
  }
  const out: Map<string, string> = new Map();
  if (isRecord(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v.trim() && ALIAS_RE.test(k)) out.set(k, v.trim());
    }
  }
  return out;
}

/**
 * The config is re-read on every lookup (it's a couple of stat calls), so an edited map file
 * applies without a restart.
 */
export function createWorkspaceAllowlist({ env = process.env }: { env?: Record<string, string | undefined> } = {}) {
  /** Alias to configured path, not yet canonical. */
  async function configuredAliases(): Promise<Map<string, string>> {
    const file = env.CLAUDE_WORKSPACE_MAP_FILE?.trim();
    return new Map([...parseCompactMap(env.CLAUDE_WORKSPACE_MAP), ...(file ? await loadMapFile(file) : [])]);
  }

  return {
    /** The allowlisted aliases, sorted (no paths, so nothing is resolved). */
    aliases: async (): Promise<string[]> => [...(await configuredAliases()).keys()].sort(),

    /**
     * Every allowlisted workspace with its canonical root, sorted by alias. One whose path doesn't
     * resolve is left out.
     */
    async list(): Promise<Array<{ alias: string; root: string }>> {
      const out = [];
      for (const [alias, raw] of [...(await configuredAliases())].sort(([a], [b]) => a.localeCompare(b))) {
        try {
          out.push({ alias, root: await canonicalDir(raw) });
        } catch {
          /* not reachable: can't be worked in */
        }
      }
      return out;
    },

    /** A null `alias` means `CLAUDE_ISSUE_DEFAULT_ALIAS`. */
    async resolveIssueWorkspace(alias: string | null): Promise<{ alias: string; root: string }> {
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
