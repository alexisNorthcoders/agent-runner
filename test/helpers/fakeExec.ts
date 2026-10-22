import { createExec } from '../../src/issuePipeline/exec.js';

/** A real exec, for tests that drive `git` over temp repos. */
export const realExec = createExec({ timeoutMs: 30_000 });

/**
 * `Exec` fake driven by a `child_process.execFile`-style handler `(cmd, args, opts, cb)`, so ported
 * tests keep their original shape. Records every call.
 * @param {() => (cmd: string, args: string[], opts: object, cb: (err: any, stdout?: string, stderr?: string) => void) => void} getHandler
 *   read on every call, so a test can swap the handler mid-way
 */
export function callbackExec(getHandler) {
  /** @type {{ cmd: string, args: string[] }[]} */
  const calls = [];
  /** @type {import('../../src/issuePipeline/exec.js').Exec} */
  const exec = (cmd, args, opts = {}) =>
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
 * @param {(args: string[]) => string | Promise<string>} gh
 */
export function realGitFakeGh(gh) {
  /** @type {string[][]} */
  const ghCalls = [];
  /** @type {import('../../src/issuePipeline/exec.js').Exec} */
  const exec = async (cmd, args, opts) => {
    if (cmd !== 'gh') return realExec(cmd, args, opts);
    ghCalls.push(args);
    return { stdout: await gh(args), stderr: '' };
  };
  return Object.assign(exec, { ghCalls });
}
