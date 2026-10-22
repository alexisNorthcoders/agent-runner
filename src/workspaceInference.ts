import { realpath as fsRealpath } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { errorText } from './narrow.ts';
import type { AgentTouch } from './agentBackend/index.js';

/**
 * A freeform run's inferred workspace: the allowlisted workspace its first edit or command works
 * in (an `AgentTouch` from the agent backend). Paths are compared by realpath, like the allowlist's
 * roots, so a symlink into a repo counts as the repo. Set once, it never changes for the run.
 */

/**
 * `p` with symlinks resolved. A path that doesn't exist yet (a file an edit creates) resolves
 * through its nearest existing ancestor.
 * @param p absolute
 */
export async function canonicalPath(p: string, realpath: (p: string) => Promise<string>): Promise<string> {
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return join(await realpath(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      rest.push(basename(cur));
      cur = up;
    }
  }
}

/**
 * The workspace the touched paths are in: the first path that is inside one decides (the deepest
 * root, if workspaces nest). Null when none is.
 * @param paths absolute
 * @param workspaces canonical roots
 */
export async function workspaceOfPaths(paths: string[], workspaces: Array<{ alias: string; root: string }>, realpath: (p: string) => Promise<string> = fsRealpath): Promise<string | null> {
  for (const p of paths) {
    const c = await canonicalPath(p, realpath);
    const inside = workspaces.filter((w) => c === w.root || c.startsWith(`${w.root}/`));
    if (inside.length) return inside.reduce((a, b) => (b.root.length > a.root.length ? b : a)).alias;
  }
  return null;
}

/**
 * Infers one run's workspace from its touches, in the order they come. `onInferred` is called at
 * most once. Lookups never throw: a run that can't be placed stays unplaced.
 * @param p `workspaces`: the allowlist, read on the first touch.
 */
export function createWorkspaceInference({ workspaces, onInferred, realpath = fsRealpath, logger = console }: {
    workspaces: () => Promise<Array<{ alias: string; root: string }>>;
    onInferred: (alias: string) => void | Promise<void>;
    realpath?: (p: string) => Promise<string>;
    logger?: Pick<Console, 'warn'>;
  }) {
  let roots: Promise<Array<{ alias: string; root: string }>> | null = null;
  let inferred: string | null = null;
  let chain = Promise.resolve();
  return {
    touch(t: AgentTouch) {
      chain = chain.then(async () => {
        if (inferred) return;
        try {
          roots ??= workspaces();
          const alias = await workspaceOfPaths(t.paths, await roots, realpath);
          if (!alias) return;
          inferred = alias;
          await onInferred(alias);
        } catch (err) {
          // read the allowlist again on the next touch
          roots = null;
          logger.warn(`workspace inference: ${errorText(err)}`);
        }
      });
      return chain;
    },
    /** The inferred workspace so far, if any. */
    get inferred() {
      return inferred;
    },
  };
}
