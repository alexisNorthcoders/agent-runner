/**
 * Runs a scheduled job's command as-is: `sh -c <command>` in its directory, with stdout and stderr
 * both appended to the log file through one file descriptor, exactly like a crontab line's
 * `>> file 2>&1`. Nothing else is written to the file. The command runs in its own process group,
 * so a stop or timeout kills everything it started.
 */

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { augmentedPathEnv } from './processPath.ts';
import { errorText } from './narrow.ts';
import type { ChildProcess } from 'child_process';

export type JobOutcome = 'success' | 'failed' | 'timeout' | 'stopped' | 'spawn_error';

export type JobResult = { outcome: JobOutcome; exitCode: number | null; signal: string | null; error?: string };

/** `done` never rejects. */
export type JobRun = { pid: number | null; done: Promise<JobResult>; stop: () => void };

export type JobStartOptions = { command: string; cwd: string; logPath: string; env?: Record<string, string>; timeoutMs: number };

const KILL_GRACE_MS = 5000;

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function createJobLauncher({ spawnFn = spawn, killProcess = killProcessGroup, killGraceMs = KILL_GRACE_MS }: { spawnFn?: typeof spawn; killProcess?: typeof killProcessGroup; killGraceMs?: number } = {}) {
  return {
    /**
     * Throws only if the log file can't be opened; a command that can't start is a `spawn_error`.
     */
    async start({ command, cwd, logPath, env = {}, timeoutMs }: JobStartOptions): Promise<JobRun> {
      await mkdir(dirname(logPath), { recursive: true });
      const fd = openSync(logPath, 'a');
      let child;
      try {
        child = spawnFn('sh', ['-c', command], {
          cwd,
          env: { ...process.env, PATH: augmentedPathEnv(), ...env },
          stdio: ['ignore', fd, fd],
          detached: true,
        });
      } finally {
        // the child has its own copy
        closeSync(fd);
      }

      let stopped = false;
      let timedOut = false;
      let closed = false;
      let killTimer: NodeJS.Timeout | null = null;
      const terminate = () => {
        if (closed) return;
        killProcess(child, 'SIGTERM');
        killTimer ??= setTimeout(() => {
          if (!closed) killProcess(child, 'SIGKILL');
        }, killGraceMs);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref();

      const done: Promise<JobResult> = new Promise((resolve) => {
        const finish = (exitCode: number | null, signal: string | null, error?: string) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          const outcome: JobOutcome = error ? 'spawn_error' : stopped ? 'stopped' : timedOut ? 'timeout' : exitCode === 0 ? 'success' : 'failed';
          resolve({ outcome, exitCode, signal, ...(error ? { error } : {}) });
        };
        child.on('error', (err) => finish(null, null, errorText(err)));
        child.on('close', (code, signal) => finish(code, signal));
      });

      return {
        pid: child.pid ?? null,
        done,
        stop() {
          stopped = true;
          terminate();
        },
      };
    },
  };
}

export type JobLauncher = ReturnType<typeof createJobLauncher>;
