import { execFile, spawn } from 'child_process';
import { createWriteStream, existsSync } from 'fs';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { finished } from 'stream/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createStreamAccumulator, resultUsage } from './claudeStreamParser.ts';
import { usageLimitFrom } from './claudeUsageLimit.ts';
import { augmentedPathEnv } from '../processPath.ts';
import { USAGE_FILE_ENV } from '../jobUsage.ts';
import { errorText, isRecord, parseJsonObject, recordOrEmpty } from '../narrow.ts';
import type { ExecFileException, ExecFileOptionsWithStringEncoding, SpawnOptionsWithStdioTuple, StdioNull, StdioPipe } from 'child_process';
import type { Readable } from 'stream';
import type { AgentBackend, AgentModelChoice, AgentResult, AgentOutcome } from './index.ts';

/**
 * The Claude Code CLI implementation of `AgentBackend` (see ./index.ts). Everything Claude-specific
 * lives here: binary lookup, CLI flags, stream-json parsing, token/cost extraction and `/implement`.
 */

/** The part of the spawned CLI process the backend uses. */
export type AgentChild = {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  kill(signal: NodeJS.Signals): boolean;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
};

export type SpawnAgent = (bin: string, args: string[], opts: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>) => AgentChild;

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
 */
export function buildClaudePrompt({ prompt, preamble, implement }: { prompt: string; preamble?: string; implement?: boolean }) {
  const lead = implement ? '/implement\n\n' : '';
  return preamble ? `${lead}${preamble}\n\n---\n\n${prompt}` : `${lead}${prompt}`;
}

/** Kill the agent's whole process group (it was spawned detached), so tool subprocesses die too. */
function killProcessGroup(child: AgentChild, signal: NodeJS.Signals) {
  try {
    if (child.pid !== undefined) return void process.kill(-child.pid, signal);
  } catch {
    /* no such group: kill the child alone */
  }
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return isRecord(e) && e.code === 'EPERM';
  }
}

/**
 * Stop an agent left running by a runner that died (it runs in its own process group, so it can
 * outlive the runner). Only a process whose command line is a headless Claude run is touched, so
 * a recycled pid is left alone.
 * @returns true once it's gone
 */
export async function stopOrphanClaude(
  pid: number,
  {
    readCmdline = async (p) => (await readFile(`/proc/${p}/cmdline`, 'utf8')).split('\0').join(' '),
    kill = (p, sig) => process.kill(-p, sig),
    isAlive = alive,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }: { readCmdline?: (pid: number) => Promise<string>; kill?: (pid: number, signal: NodeJS.Signals) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void> } = {}
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  const cmd = await readCmdline(pid).catch(() => '');
  if (!cmd.includes('--output-format stream-json') || !cmd.includes('-p')) return false;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
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
 */
export async function repoSettingsModel(cwd: string): Promise<string | null> {
  for (const name of ['settings.local.json', 'settings.json']) {
    try {
      const model = parseJsonObject(await readFile(join(cwd, '.claude', name), 'utf8'))?.model;
      if (typeof model === 'string' && model.trim()) return model.trim();
    } catch {
      /* missing or malformed: try the next one */
    }
  }
  return null;
}

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
}: {
    bin?: string;
    model?: string;
    timeoutMs: number;
    resultExitGraceMs?: number;
    spawnFn?: SpawnAgent;
    killProcess?: (child: AgentChild, signal: NodeJS.Signals) => void;
    now?: () => number;
  }): AgentBackend {
  return {
    name: 'claude',
    stopOrphan: (pid) => stopOrphanClaude(pid),
    async start({ prompt, preamble, implement, model: requested, modelSource = 'prefix', cwd, logPath, onProgress, onTouch, resume }) {
      await mkdir(dirname(logPath), { recursive: true });
      const workspaceModel = requested ? null : await repoSettingsModel(cwd);
      const choice: AgentModelChoice = requested
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
        ['-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...(resume ? ['--resume', resume.sessionId, '--fork-session'] : []), buildClaudePrompt({ prompt, preamble, implement })],
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
      let killTimer: NodeJS.Timeout | null = null;
      let resultTimer: NodeJS.Timeout | null = null;

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

      const logLines = (lines: string[]) => {
        for (const l of lines) log.write(`[out] ${l}\n`);
      };

      const done: Promise<AgentResult> = new Promise((resolve) => {
        const finish = ({ exitCode, spawnError }: { exitCode: number | null; spawnError?: string }) => {
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
          const outcome: AgentOutcome = spawnError
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
          const sessionMissing = Boolean(resume) && failed && /no conversation found/i.test(`${stderr}\n${text}`);
          log.end(`\n--- process end outcome=${outcome} exit=${exitCode ?? 'n/a'} ---\n`);
          const result = {
            outcome,
            exitCode,
            text,
            stderr: spawnError ?? stderr,
            logPath,
            ...(sessionMissing ? { sessionMissing } : {}),
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
            'code' in err && err.code === 'ENOENT'
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

/** The read-only (repo-insight) session's model unless `REPO_INSIGHT_MODEL` names another; not `CLAUDE_AGENT_MODEL`, which pins every other run. */
export const READ_ONLY_DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * @returns argv for a one-shot, read-only `claude -p` session
 */
export function readOnlySessionArgs({ prompt, model = process.env.REPO_INSIGHT_MODEL?.trim() || READ_ONLY_DEFAULT_MODEL }: { prompt: string; model?: string }): string[] {
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

export type ExecFileAgent = (
  bin: string,
  args: string[],
  opts: ExecFileOptionsWithStringEncoding,
  cb: (err: ExecFileException | null, stdout: string, stderr: string) => void
) => { stdin: { end(): unknown } | null } | void;

type AppendFile = (path: string, data: string) => Promise<void>;

/**
 * Append a session's usage to the scheduled job's usage file (./jobUsage.ts), when the runner set
 * one. A failed write is logged, not thrown: it must not fail the session.
 * @param out the CLI's JSON result
 */
async function reportJobUsage(out: unknown, { usageFile, appendFileFn = appendFile }: { usageFile?: string; appendFileFn?: AppendFile }) {
  if (!usageFile) return;
  try {
    await appendFileFn(usageFile, `${JSON.stringify(resultUsage(out))}\n`);
  } catch (err) {
    console.warn(`cannot write usage file ${usageFile}:`, errorText(err));
  }
}

/**
 * Launch a read-only exploration session in `cwd` and return its final text. The same seam shape
 * as `repoInsight`'s `launchSession`; tests inject a fake instead of spawning the CLI. Its model,
 * cost and tokens go to `AGENT_RUNNER_USAGE_FILE` (even for a session that reports an error), so
 * the scheduled job's history row shows them.
 */
export function createReadOnlySessionLauncher({
  bin = resolveClaudeBin(),
  timeoutMs = 15 * 60_000,
  execFileFn = execFile,
  usageFile = process.env[USAGE_FILE_ENV]?.trim(),
  appendFileFn,
}: {
    bin?: string;
    timeoutMs?: number;
    execFileFn?: ExecFileAgent;
    usageFile?: string;
    appendFileFn?: AppendFile;
  } = {}): (p: { cwd: string; prompt: string }) => Promise<{ text: string }> {
  return ({ cwd, prompt }) =>
    new Promise((resolve, reject) => {
      const child = execFileFn(
        bin,
        readOnlySessionArgs({ prompt }),
        { cwd, env: { ...process.env, PATH: augmentedPathEnv() }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`exploration session failed: ${String(stderr || '').trim().slice(0, 300) || err.message}`));
          let out: unknown;
          try {
            out = JSON.parse(stdout);
          } catch {
            return reject(new Error('exploration session printed no JSON result'));
          }
          const result = recordOrEmpty(out);
          reportJobUsage(out, { usageFile, appendFileFn }).then(() => {
            if (result.is_error) return reject(new Error(`exploration session reported an error: ${String(result.result ?? '').slice(0, 300)}`));
            resolve({ text: String(result.result ?? '') });
          });
        }
      );
      // The prompt is an argument; an open stdin pipe makes the CLI wait 3s for input first.
      child?.stdin?.end();
    });
}
