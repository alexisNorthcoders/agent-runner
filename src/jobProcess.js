import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { augmentedPathEnv } from './processPath.js';

/**
 * Runs a scheduled job's command as-is: `sh -c <command>` in its directory, with stdout and stderr
 * both appended to the log file through one file descriptor, exactly like a crontab line's
 * `>> file 2>&1`. Nothing else is written to the file. The command runs in its own process group,
 * so a stop or timeout kills everything it started.
 *
 * @typedef {'success' | 'failed' | 'timeout' | 'stopped' | 'spawn_error'} JobOutcome
 * @typedef {{ outcome: JobOutcome, exitCode: number | null, signal: string | null, error?: string }} JobResult
 * @typedef {{ pid: number | null, done: Promise<JobResult>, stop: () => void }} JobRun
 *   `done` never rejects.
 * @typedef {{ command: string, cwd: string, logPath: string, env?: Record<string, string>, timeoutMs: number }} JobStartOptions
 */

const KILL_GRACE_MS = 5000;

/** @param {import('child_process').ChildProcess} child @param {NodeJS.Signals} signal */
function killProcessGroup(child, signal) {
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

/**
 * @param {{ spawnFn?: typeof spawn, killProcess?: typeof killProcessGroup, killGraceMs?: number }} [p]
 */
export function createJobLauncher({ spawnFn = spawn, killProcess = killProcessGroup, killGraceMs = KILL_GRACE_MS } = {}) {
  return {
    /**
     * Throws only if the log file can't be opened; a command that can't start is a `spawn_error`.
     * @param {JobStartOptions} opts
     * @returns {Promise<JobRun>}
     */
    async start({ command, cwd, logPath, env = {}, timeoutMs }) {
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
      /** @type {NodeJS.Timeout | null} */
      let killTimer = null;
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

      /** @type {Promise<JobResult>} */
      const done = new Promise((resolve) => {
        /** @param {number | null} exitCode @param {string | null} signal @param {string} [error] */
        const finish = (exitCode, signal, error) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          /** @type {JobOutcome} */
          const outcome = error ? 'spawn_error' : stopped ? 'stopped' : timedOut ? 'timeout' : exitCode === 0 ? 'success' : 'failed';
          resolve({ outcome, exitCode, signal, ...(error ? { error } : {}) });
        };
        child.on('error', (err) => finish(null, null, err.message));
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

/** @typedef {ReturnType<typeof createJobLauncher>} JobLauncher */
