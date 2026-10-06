import { execFile, spawn } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { mkdir } from 'fs/promises';
import { finished } from 'stream/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createStreamAccumulator } from './claudeStreamParser.js';
import { usageLimitFrom } from './claudeUsageLimit.js';
import { augmentedPathEnv } from '../processPath.js';

/**
 * The Claude Code CLI implementation of `AgentBackend` (see ./index.js). Everything Claude-specific
 * lives here: binary lookup, CLI flags, stream-json parsing, token/cost extraction and `/implement`.
 */

const MAX_STDERR_BYTES = 256 * 1024;
const KILL_GRACE_MS = 5000;
/**
 * How long the CLI gets to exit after its final `result`. It stays alive while the agent's
 * background tasks (background Bash, Monitor watchers) are pending, and each one that ends wakes the
 * model for another turn, so a finished run could idle on to the timeout. Past this, it's ended.
 */
const RESULT_EXIT_GRACE_MS = 10_000;

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

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Stop an agent left running by a runner that died (it runs in its own process group, so it can
 * outlive the runner). Only a process whose command line is a headless Claude run is touched, so
 * a recycled pid is left alone.
 * @param {number} pid
 * @param {{ readCmdline?: (pid: number) => Promise<string>, kill?: (pid: number, signal: NodeJS.Signals) => void, isAlive?: (pid: number) => boolean, sleep?: (ms: number) => Promise<void> }} [deps]
 * @returns {Promise<boolean>} true once it's gone
 */
export async function stopOrphanClaude(
  pid,
  {
    readCmdline = async (p) => (await readFile(`/proc/${p}/cmdline`, 'utf8')).split('\0').join(' '),
    kill = (p, sig) => process.kill(-p, sig),
    isAlive = alive,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {}
) {
  if (!isAlive(pid)) return true;
  const cmd = await readCmdline(pid).catch(() => '');
  if (!cmd.includes('--output-format stream-json') || !cmd.includes('-p')) return false;
  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGKILL'])) {
    try {
      kill(pid, signal);
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 25 && isAlive(pid); i++) await sleep(200);
    if (!isAlive(pid)) return true;
  }
  return false;
}

/**
 * The `model` a repo sets for itself in `.claude/settings.local.json`, else `.claude/settings.json`
 * (Claude Code's own precedence). Missing or unreadable files don't count.
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
export async function repoSettingsModel(cwd) {
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const model = JSON.parse(await readFile(join(cwd, '.claude', name), 'utf8'))?.model;
      if (typeof model === 'string' && model.trim()) return model.trim();
    } catch {
      /* missing or malformed: try the next one */
    }
  }
  return null;
}

/**
 * @param {{
 *   bin?: string,
 *   model?: string,
 *   timeoutMs: number,
 *   resultExitGraceMs?: number,
 *   spawnFn?: typeof spawn,
 *   killProcess?: (child: import('child_process').ChildProcess, signal: NodeJS.Signals) => void,
 *   now?: () => number,
 * }} p
 * @returns {import('./index.js').AgentBackend}
 */
export function createClaudeBackend({
  bin = resolveClaudeBin(),
  // Pinned so runs don't silently follow the interactive CLI default in ~/.claude/settings.json.
  // A repo's own .claude settings still win (see repoSettingsModel).
  model: pinnedModel = process.env.CLAUDE_AGENT_MODEL?.trim() || 'sonnet',
  timeoutMs,
  resultExitGraceMs = RESULT_EXIT_GRACE_MS,
  spawnFn = spawn,
  killProcess = killProcessGroup,
  now = Date.now,
}) {
  return {
    name: 'claude',
    stopOrphan: (pid) => stopOrphanClaude(pid),
    async start({ prompt, preamble, implement, model: requested, modelSource = 'prefix', cwd, logPath, onProgress, onTouch }) {
      await mkdir(dirname(logPath), { recursive: true });
      const workspaceModel = requested ? null : await repoSettingsModel(cwd);
      /** @type {import('./index.js').AgentModelChoice} */
      const choice = requested
        ? { name: requested, source: modelSource }
        : workspaceModel
          ? { name: workspaceModel, source: 'workspace' }
          : { name: pinnedModel, source: 'default' };
      const model = choice.name;
      const log = createWriteStream(logPath, { flags: 'w' });
      // a log failure (disk full…) must not crash the runner or fail the run
      log.on('error', () => {});
      log.write(`cwd=${cwd}\nbin=${bin}\nmodel=${model}\n--- prompt ---\n${prompt}\n--- (preamble prepended for the agent) ---\n\n`);

      const stream = createStreamAccumulator({ cwd, onTouch });
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
      /** ended by the result grace: its final result came, but it didn't exit */
      let endedAfterResult = false;
      /** @type {NodeJS.Timeout | null} */
      let killTimer = null;
      /** @type {NodeJS.Timeout | null} */
      let resultTimer = null;

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
          if (resultTimer) clearTimeout(resultTimer);
          logLines(stream.flush());
          const snap = stream.snapshot();
          const text = snap.result?.text || snap.assistantText;
          // killed after its final result (by the result grace or the timeout): the result is the outcome
          const resultEnded = Boolean(snap.result) && (endedAfterResult || timedOut);
          const failed = (exitCode !== 0 && !resultEnded) || Boolean(snap.result?.isError);
          // the run failed (the CLI may still exit 0 with an error result) and the stream signalled the
          // usage limit; the text only supplies the reset time
          const hitLimit = failed && snap.rateLimited;
          /** @type {import('./index.js').AgentOutcome} */
          const outcome = spawnError
            ? 'spawn_error'
            : stopped
              ? 'stopped'
              : timedOut && !resultEnded
                ? 'timeout'
                : hitLimit
                  ? 'limited'
                  : !failed
                    ? 'success'
                    : 'failed';
          log.end(`\n--- process end outcome=${outcome} exit=${exitCode ?? 'n/a'} ---\n`);
          const result = {
            outcome,
            exitCode,
            text,
            stderr: spawnError ?? stderr,
            logPath,
            ...(outcome === 'limited' ? { limit: usageLimitFrom({ text, resetsAtEpoch: snap.rejectedResetsAt, now: now() }) } : {}),
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
          if (s.result && !resultTimer && !closed) {
            resultTimer = setTimeout(() => {
              if (closed || stopped || timedOut) return;
              endedAfterResult = true;
              log.write(`--- result received but the CLI is still running (pending background tasks): ending it ---\n`);
              terminate();
            }, resultExitGraceMs);
            resultTimer.unref();
          }
          onProgress?.({ model: s.model, turns: s.turns, outputTokens: s.outputTokens, contextTokens: s.contextTokens, lastActivity: s.lastActivity, subagents: s.subagents });
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
        model: choice,
        done,
        stop() {
          stopped = true;
          terminate();
        },
      };
    },
  };
}

/**
 * Tools a read-only exploration session may use. `--tools` restricts the built-in set itself, so
 * editing and shell tools aren't merely refused: they don't exist for the session. The deny list is
 * a second layer, and the permission mode never prompts, so anything unlisted is refused.
 */
export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
export const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

/**
 * @param {{ prompt: string, model?: string }} p
 * @returns {string[]} argv for a one-shot, read-only `claude -p` session
 */
export function readOnlySessionArgs({ prompt, model = process.env.CLAUDE_AGENT_MODEL?.trim() || 'sonnet' }) {
  return [
    '-p',
    '--model', model,
    '--output-format', 'json',
    '--permission-mode', 'default',
    '--tools', READ_ONLY_TOOLS.join(','),
    '--disallowedTools', READ_ONLY_DISALLOWED_TOOLS.join(','),
    // `--tools` and `--disallowedTools` are variadic: without `--` the prompt is read as a tool name.
    '--',
    prompt,
  ];
}

/**
 * Launch a read-only exploration session in `cwd` and return its final text. The same seam shape
 * as `repoInsight`'s `launchSession`; tests inject a fake instead of spawning the CLI.
 * @param {{
 *   bin?: string,
 *   timeoutMs?: number,
 *   execFileFn?: typeof import('child_process').execFile,
 * }} [deps]
 * @returns {(p: { cwd: string, prompt: string }) => Promise<{ text: string }>}
 */
export function createReadOnlySessionLauncher({ bin = resolveClaudeBin(), timeoutMs = 15 * 60_000, execFileFn = execFile } = {}) {
  return ({ cwd, prompt }) =>
    new Promise((resolve, reject) => {
      const child = execFileFn(
        bin,
        readOnlySessionArgs({ prompt }),
        { cwd, env: { ...process.env, PATH: augmentedPathEnv() }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`exploration session failed: ${String(stderr || '').trim().slice(0, 300) || err.message}`));
          try {
            const out = JSON.parse(stdout);
            if (out?.is_error) return reject(new Error(`exploration session reported an error: ${String(out.result ?? '').slice(0, 300)}`));
            resolve({ text: String(out?.result ?? '') });
          } catch {
            reject(new Error('exploration session printed no JSON result'));
          }
        }
      );
      // The prompt is an argument; an open stdin pipe makes the CLI wait 3s for input first.
      child?.stdin?.end();
    });
}
