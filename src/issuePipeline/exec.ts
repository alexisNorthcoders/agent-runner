import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { augmentedPathEnv } from '../processPath.ts';
import { errorText, recordOrEmpty } from '../narrow.ts';

export type ExecOptions = { cwd?: string; maxBuffer?: number; timeout?: number };

/**
 * The seam for every `git` and `gh` call the issue pipeline makes. Tests inject a fake with the
 * same shape (often delegating `git` to a real exec over a temp repo). Rejects with an Error
 * carrying `stdout`, `stderr` and `code` (`ENOENT` when the binary is missing).
 */
export type Exec = (cmd: 'git' | 'gh', args: string[], opts?: ExecOptions) => Promise<{ stdout: string; stderr: string }>;

/** GH_BIN, then common install locations, then `gh` on PATH. */
export function resolveGhBin(fromEnv?: string) {
  if (fromEnv) return fromEnv;
  for (const p of [join(homedir(), '.local', 'bin', 'gh'), '/usr/bin/gh', '/usr/local/bin/gh']) {
    if (existsSync(p)) return p;
  }
  return 'gh';
}

/**
 * @param p `timeoutMs` applies unless a call sets its own
 */
export function createExec({ timeoutMs, ghBin }: { timeoutMs: number; ghBin?: string }): Exec {
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

/** stderr, else the message, of a failed exec. */
export function execErrorText(e: unknown): string {
  const { stderr } = recordOrEmpty(e);
  return (typeof stderr === 'string' && stderr) || errorText(e);
}

/** `git <args>` in `cwd`. */
export async function git(exec: Exec, args: string[], cwd: string) {
  const { stdout, stderr } = await exec('git', args, { cwd });
  return { stdout: stdout || '', stderr: stderr || '' };
}
