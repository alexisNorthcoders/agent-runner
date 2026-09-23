import { spawn } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { finished } from 'stream/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createStreamAccumulator } from './claudeStreamParser.js';

/**
 * The Claude Code CLI implementation of `AgentBackend` (see ./index.js). Everything Claude-specific
 * lives here: binary lookup, CLI flags, stream-json parsing, token/cost extraction and `/implement`.
 */

const MAX_STDERR_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5000;

/** Paths often missing when started by PM2/systemd rather than an interactive shell. */
export function augmentedPathEnv(base = process.env.PATH || '') {
  const home = homedir();
  const extra = [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/usr/local/bin'].join(':');
  return base ? `${extra}:${base}` : extra;
}

/** CLAUDE_AGENT_BIN, then common install locations, then `claude` on PATH. */
export function resolveClaudeBin(env = process.env) {
  const fromEnv = env.CLAUDE_AGENT_BIN?.trim();
  if (fromEnv) return fromEnv;
  const home = homedir();
  for (const p of [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude']) {
    if (existsSync(p)) return p;
  }
  return 'claude';
}

/**
 * Slash commands are only recognized as the very first characters of the message, so the
 * `/implement` skill goes before the preamble.
 * @param {{ prompt: string, preamble?: string, implement?: boolean }} p
 */
export function buildClaudePrompt({ prompt, preamble, implement }) {
  const lead = implement ? '/implement\n\n' : '';
  return preamble ? `${lead}${preamble}\n\n---\n\n${prompt}` : `${lead}${prompt}`;
}

/** Kill the agent's whole process group (it was spawned detached), so tool subprocesses die too. */
function killProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * @param {{
 *   bin?: string,
 *   model?: string,
 *   timeoutMs: number,
 *   spawnFn?: typeof spawn,
 *   killProcess?: (child: import('child_process').ChildProcess, signal: NodeJS.Signals) => void,
 * }} p
 * @returns {import('./index.js').AgentBackend}
 */
export function createClaudeBackend({
  bin = resolveClaudeBin(),
  // Pinned so runs don't silently follow the interactive CLI default in ~/.claude/settings.json.
  model = process.env.CLAUDE_AGENT_MODEL?.trim() || 'sonnet',
  timeoutMs,
  spawnFn = spawn,
  killProcess = killProcessGroup,
}) {
  return {
    name: 'claude',
    async start({ prompt, preamble, implement, cwd, logPath, onProgress }) {
      await mkdir(dirname(logPath), { recursive: true });
      const log = createWriteStream(logPath, { flags: 'w' });
      // a log failure (disk full…) must not crash the runner or fail the run
      log.on('error', () => {});
      log.write(`cwd=${cwd}\nbin=${bin}\nmodel=${model}\n--- prompt ---\n${prompt}\n--- (preamble prepended for the agent) ---\n\n`);

      const stream = createStreamAccumulator();
      const child = spawnFn(
        bin,
        ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', buildClaudePrompt({ prompt, preamble, implement })],
        {
          cwd,
          env: { ...process.env, PATH: augmentedPathEnv() },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        }
      );

      let stderr = '';
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
        }, KILL_GRACE_MS);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      timer.unref();

      const logLines = (lines) => {
        for (const l of lines) log.write(`[out] ${l}\n`);
      };

      /** @type {Promise<import('./index.js').AgentResult>} */
      const done = new Promise((resolve) => {
        /** @param {{ exitCode: number | null, spawnError?: string }} p */
        const finish = ({ exitCode, spawnError }) => {
          if (closed) return;
          closed = true;
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          logLines(stream.flush());
          const snap = stream.snapshot();
          /** @type {import('./index.js').AgentOutcome} */
          const outcome = spawnError
            ? 'spawn_error'
            : stopped
              ? 'stopped'
              : timedOut
                ? 'timeout'
                : exitCode === 0
                  ? 'success'
                  : 'failed';
          log.end(`\n--- process end outcome=${outcome} exit=${exitCode ?? 'n/a'} ---\n`);
          const result = {
            outcome,
            exitCode,
            text: snap.result?.text || snap.assistantText,
            stderr: spawnError ?? stderr,
            logPath,
            usage: {
              model: snap.model,
              sessionId: snap.sessionId,
              turns: snap.result?.turns ?? snap.turns,
              costUsd: snap.result?.costUsd ?? null,
              tokens: snap.result?.tokens ?? { input: snap.contextTokens, output: snap.outputTokens, cacheRead: 0, cacheCreate: 0 },
            },
          };
          // resolve once the log is flushed, so readers of `logPath` see the whole run
          finished(log).then(
            () => resolve(result),
            () => resolve(result)
          );
        };

        child.stdout.on('data', (d) => {
          logLines(stream.push(d));
          const s = stream.snapshot();
          onProgress?.({ model: s.model, turns: s.turns, outputTokens: s.outputTokens, contextTokens: s.contextTokens, lastActivity: s.lastActivity });
        });
        child.stderr.on('data', (d) => {
          if (stderr.length < MAX_STDERR_BYTES) stderr += d.toString('utf8');
          log.write('[err] ');
          log.write(d);
        });
        child.on('error', (err) => {
          const hint =
            /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT'
              ? `${err.message}: no "claude" on the runner's PATH. Run \`which claude\` in a shell where it works and set CLAUDE_AGENT_BIN in .env to that path.`
              : err.message;
          finish({ exitCode: null, spawnError: hint });
        });
        child.on('close', (code) => finish({ exitCode: code }));
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
