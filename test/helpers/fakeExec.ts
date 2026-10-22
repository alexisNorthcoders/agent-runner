import { createExec } from '../../src/issuePipeline/exec.js';
import type { Exec } from '../../src/issuePipeline/exec.js';

/** A real exec, for tests that drive `git` over temp repos. */
export const realExec = createExec({ timeoutMs: 30_000 });

/**
 * `Exec` fake driven by a `child_process.execFile`-style handler `(cmd, args, opts, cb)`, so ported
 * tests keep their original shape. Records every call. `getHandler` is read on every call, so a test
 * can swap the handler mid-way.
 */
export function callbackExec(getHandler: () => (cmd: string, args: string[], opts: object, cb: (err: (Error & { stderr?: string }) | null, stdout?: string, stderr?: string) => void) => void) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      calls.push({ cmd, args: [...args] });
      getHandler()(cmd, args, opts, (err, stdout = '', stderr = '') => {
        if (err) reject(Object.assign(err, { stdout, stderr: err.stderr ?? stderr }));
        else resolve({ stdout, stderr });
      });
    });
  return Object.assign(exec, { calls });
}

/**
 * `Exec` that runs `git` for real and answers `gh` from `gh(args)` (a string is stdout; throw to fail).
 */
export function realGitFakeGh(gh: (args: string[]) => string | Promise<string>) {
  const ghCalls: string[][] = [];
  const exec: Exec = async (cmd, args, opts) => {
    if (cmd !== 'gh') return realExec(cmd, args, opts);
    ghCalls.push(args);
    return { stdout: await gh(args), stderr: '' };
  };
  return Object.assign(exec, { ghCalls });
}
