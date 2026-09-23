import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { augmentedPathEnv } from '../agentBackend/claude.js';

/**
 * The seam for every `git` and `gh` call the issue pipeline makes. Tests inject a fake with the
 * same shape (often delegating `git` to a real exec over a temp repo).
 *
 * @typedef {{ cwd?: string, maxBuffer?: number, timeout?: number }} ExecOptions
 * @typedef {(cmd: 'git' | 'gh', args: string[], opts?: ExecOptions) => Promise<{ stdout: string, stderr: string }>} Exec
 *   Rejects with an Error carrying `stdout`, `stderr` and `code` (`ENOENT` when the binary is missing).
 */

/** GH_BIN, then common install locations, then `gh` on PATH. @param {string} [fromEnv] */
export function resolveGhBin(fromEnv) {
  if (fromEnv) return fromEnv;
  for (const p of [join(homedir(), '.local', 'bin', 'gh'), '/usr/bin/gh', '/usr/local/bin/gh']) {
    if (existsSync(p)) return p;
  }
  return 'gh';
}

/**
 * @param {{ timeoutMs: number, ghBin?: string }} p `timeoutMs` applies unless a call sets its own
 * @returns {Exec}
 */
export function createExec({ timeoutMs, ghBin }) {
  const gh = resolveGhBin(ghBin);
  const env = { ...process.env, PATH: augmentedPathEnv() };
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd === 'gh' ? gh : cmd,
        args,
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs, env, ...opts },
        (err, stdout, stderr) => {
          if (err) {
            Object.assign(err, { stdout, stderr });
            reject(err);
          } else resolve({ stdout: stdout || '', stderr: stderr || '' });
        }
      );
    });
}

/** stderr, else the message, of a failed exec. @param {any} e */
export const execErrorText = (e) => e?.stderr || e?.message || String(e);

/**
 * `git <args>` in `cwd`.
 * @param {Exec} exec @param {string[]} args @param {string} cwd
 */
export async function git(exec, args, cwd) {
  const { stdout, stderr } = await exec('git', args, { cwd });
  return { stdout: stdout || '', stderr: stderr || '' };
}
