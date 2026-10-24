/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` output (NDJSON).
 * Pure: feed it stdout chunks, get back human-readable log lines and a snapshot of what the
 * run is doing / has cost so far. Unknown or malformed lines are tolerated (returned verbatim).
 */

import { StringDecoder } from 'string_decoder';
import { createToolTouchReader } from './claudeToolTouch.ts';
import { numberOrNull, recordOrEmpty, stringOrNull } from '../narrow.ts';
import type { AgentSubagent, AgentTokens, AgentTouch } from './index.ts';

function truncate(s: unknown, n: number) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Short "what is the agent doing" label for a tool_use block, e.g. `Bash: git status`.
 */
export function describeToolUse(name: string, input: Record<string, unknown> = {}) {
  const pick =
    input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? input.url ?? input.query;
  return pick == null ? String(name) : `${name}: ${truncate(pick, 80)}`;
}

/** A stream-json count (`usage.input_tokens`…), 0 when missing. */
const count = (v: unknown) => numberOrNull(v) || 0;

function sumModelUsage(modelUsage: unknown): AgentTokens {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const u of Object.values(recordOrEmpty(modelUsage)).map(recordOrEmpty)) {
    totals.input += count(u.inputTokens);
    totals.output += count(u.outputTokens);
    totals.cacheRead += count(u.cacheReadInputTokens);
    totals.cacheCreate += count(u.cacheCreationInputTokens);
  }
  return totals;
}

/** Model that accounted for the most spend (falls back to the first listed). */
function primaryModel(modelUsage: unknown) {
  const entries = Object.entries(recordOrEmpty(modelUsage)).map(([model, u]) => [model, count(recordOrEmpty(u).costUSD)] as const);
  if (!entries.length) return null;
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

export type ResultUsage = { model: string | null; costUsd: number | null; turns: number | null; tokens: AgentTokens };

/**
 * The model, cost, turns and tokens of a CLI `result` (the last stream-json event, or the whole
 * `--output-format json` output).
 */
export function resultUsage(ev: unknown): ResultUsage {
  const r = recordOrEmpty(ev);
  const usage = recordOrEmpty(r.usage);
  const tokens = r.modelUsage
    ? sumModelUsage(r.modelUsage)
    : {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheCreate: count(usage.cache_creation_input_tokens),
      };
  return {
    model: primaryModel(r.modelUsage),
    costUsd: numberOrNull(r.total_cost_usd),
    turns: numberOrNull(r.num_turns),
    tokens,
  };
}

/**
 * `rejectedResetsAt` is the reset epoch of a rate-limit event that rejected the run (the usage
 * limit), when one came. `rateLimited` is whether the stream signalled the usage limit: that
 * rejected event, or the CLI's synthetic assistant message flagged `error: "rate_limit"`.
 * `subagents`: the subagents running now, oldest first. Their messages (tagged with the
 * `parent_tool_use_id` of the tool call that spawned them) count toward `outputTokens` but not
 * the main agent's `turns`, `contextTokens` or `lastActivity`, and their log lines are prefixed
 * with their description.
 */
export type StreamSnapshot = {
  model: string | null;
  sessionId: string | null;
  turns: number;
  outputTokens: number;
  contextTokens: number;
  lastActivity: string | null;
  rateLimits: { fiveHour: number | null; sevenDay: number | null } | null;
  rejectedResetsAt: number | null;
  rateLimited: boolean;
  assistantText: string;
  subagents: AgentSubagent[];
  result: null | {
    text: string;
    isError: boolean;
    costUsd: number | null;
    turns: number | null;
    durationMs: number | null;
    tokens: AgentTokens;
  };
};

/** The tool calls that spawn a subagent (the CLI's older and newer names for it). */
const SPAWN_TOOLS: ReadonlySet<unknown> = new Set(['Agent', 'Task']);
/** A task's statuses once it's over. */
const TASK_OVER: ReadonlySet<unknown> = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error']);

/** `onTouch` hears each edit or command tool call (./claudeToolTouch.ts), read from `cwd`. */
export function createStreamAccumulator({ cwd = process.cwd(), onTouch }: { cwd?: string; onTouch?: (t: AgentTouch) => void } = {}) {
  const touches = onTouch ? createToolTouchReader({ cwd }) : null;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const state: StreamSnapshot = {
    model: null,
    sessionId: null,
    turns: 0,
    outputTokens: 0,
    contextTokens: 0,
    lastActivity: null,
    rateLimits: null,
    rejectedResetsAt: null,
    rateLimited: false,
    assistantText: '',
    subagents: [],
    result: null,
  };
  /** message id -> output tokens (assistant events repeat per content block; count each id once) */
  const outputByMessage = new Map<unknown, number>();
  /** A background task's id -> the tool call (its subagent's id) that spawned it. */
  const taskTool = new Map<string, string>();

  const subagent = (id: unknown) => state.subagents.find((a) => a.id === id);
  const taskSubagent = (taskId: unknown) => (typeof taskId === 'string' ? taskTool.get(taskId) : undefined);
  /** A subagent spawned by tool call `id`, unless it's already known. */
  function spawned(id: string, input: Record<string, unknown>): AgentSubagent {
    const known = subagent(id);
    const description = typeof input.description === 'string' && input.description.trim() ? truncate(input.description, 60) : 'subagent';
    const type = stringOrNull(input.subagent_type);
    if (known) {
      known.description = description;
      known.type = type ?? known.type;
      return known;
    }
    const added: AgentSubagent = { id, description, type, activity: null };
    state.subagents = [...state.subagents, added];
    return added;
  }
  /** The subagent spawned by tool call `id` is done. */
  function finished(id: unknown) {
    if (id) state.subagents = state.subagents.filter((a) => a.id !== id);
  }
  function countOutput(m: Record<string, unknown>, usage: Record<string, unknown>) {
    outputByMessage.set(m.id, count(usage.output_tokens));
    state.outputTokens = [...outputByMessage.values()].reduce((a, b) => a + b, 0);
  }
  const contentBlocks = (m: Record<string, unknown>) => (Array.isArray(m.content) ? m.content.map(recordOrEmpty) : []);

  /**
   * A subagent's message: its output tokens count, its tool calls and text are its own activity,
   * and its log lines say whose they are. One the parser never saw spawned is picked up here.
   */
  function subagentSays(ev: Record<string, unknown>, parentToolUseId: string): string[] {
    const m = recordOrEmpty(ev.message);
    if (m.id && m.usage) countOutput(m, recordOrEmpty(m.usage));
    const who = subagent(parentToolUseId) ?? spawned(parentToolUseId, { description: ev.task_description, subagent_type: ev.subagent_type });
    const lines = [];
    for (const block of contentBlocks(m)) {
      if (block.type === 'tool_use') {
        const input = recordOrEmpty(block.input);
        who.activity = describeToolUse(String(block.name), input);
        lines.push(`[${who.description}] → ${who.activity}`);
        // a subagent spawning its own
        if (SPAWN_TOOLS.has(block.name) && typeof block.id === 'string') spawned(block.id, input);
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        who.activity = 'writing…';
        lines.push(`[${who.description}] ${truncate(block.text, 300)}`);
      }
    }
    return lines;
  }

  function handle(ev: Record<string, unknown>): string[] {
    const sessionId = stringOrNull(ev.session_id);
    if (sessionId) state.sessionId = sessionId;

    if (ev.type === 'system' && ev.subtype === 'init') {
      const model = stringOrNull(ev.model);
      if (model) state.model = model;
      return [];
    }

    if (ev.type === 'system' && ev.subtype === 'task_started' && typeof ev.tool_use_id === 'string') {
      if (typeof ev.task_id === 'string') taskTool.set(ev.task_id, ev.tool_use_id);
      spawned(ev.tool_use_id, ev);
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'task_updated' && TASK_OVER.has(recordOrEmpty(ev.patch).status)) {
      finished(taskSubagent(ev.task_id));
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'task_notification') {
      finished(typeof ev.tool_use_id === 'string' ? ev.tool_use_id : taskSubagent(ev.task_id));
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
      // a background subagent no longer listed is over, however its end was missed
      const live = new Set(ev.tasks.map((x) => taskSubagent(recordOrEmpty(x).task_id)).filter(Boolean));
      const background = new Set(taskTool.values());
      state.subagents = state.subagents.filter((a) => !background.has(a.id) || live.has(a.id));
      return [];
    }

    // a foreground subagent's tool call returns when it's done (a background one's straight away, launched)
    const message = recordOrEmpty(ev.message);
    if (ev.type === 'user' && !ev.parent_tool_use_id && Array.isArray(message.content)) {
      const toolResult = recordOrEmpty(ev.tool_use_result);
      for (const block of contentBlocks(message)) {
        if (block.type !== 'tool_result' || !subagent(block.tool_use_id)) continue;
        if (toolResult.status === 'async_launched' || toolResult.isAsync) continue;
        finished(block.tool_use_id);
      }
      return [];
    }

    if (ev.type === 'rate_limit_event') {
      const info = recordOrEmpty(ev.rate_limit_info);
      if (info.status === 'rejected') {
        state.rateLimited = true;
        if (typeof info.resetsAt === 'number') state.rejectedResetsAt = info.resetsAt;
      }
      if (info.unifiedWindows) {
        const w = recordOrEmpty(info.unifiedWindows);
        state.rateLimits = {
          fiveHour: numberOrNull(recordOrEmpty(w.five_hour).utilization),
          sevenDay: numberOrNull(recordOrEmpty(w.seven_day).utilization),
        };
      }
      return [];
    }

    if (ev.type === 'assistant' && ev.message && typeof ev.parent_tool_use_id === 'string') return subagentSays(ev, ev.parent_tool_use_id);

    if (ev.type === 'assistant' && ev.message) {
      if (ev.error === 'rate_limit') state.rateLimited = true;
      const m = message;
      const model = stringOrNull(m.model);
      if (model) state.model = model;
      if (m.id && !outputByMessage.has(m.id)) state.turns += 1;
      if (m.id && m.usage) {
        const usage = recordOrEmpty(m.usage);
        countOutput(m, usage);
        const ctx = count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
        // later events for the same message can carry only output_tokens; keep the last real context size
        if (ctx > 0) state.contextTokens = ctx;
      }
      const lines = [];
      for (const block of contentBlocks(m)) {
        if (block.type === 'tool_use') {
          const input = recordOrEmpty(block.input);
          state.lastActivity = describeToolUse(String(block.name), input);
          lines.push(`→ ${state.lastActivity}`);
          if (SPAWN_TOOLS.has(block.name) && typeof block.id === 'string') spawned(block.id, input);
          const touch = touches?.read(String(block.name), input);
          if (touch) onTouch?.(touch);
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          state.assistantText = block.text;
          state.lastActivity = 'writing…';
          lines.push(`assistant: ${truncate(block.text, 500)}`);
        }
      }
      return lines;
    }

    if (ev.type === 'result') {
      const { model, costUsd, tokens } = resultUsage(ev);
      const turns = numberOrNull(ev.num_turns);
      state.model = model ?? state.model;
      state.result = {
        text: typeof ev.result === 'string' ? ev.result : '',
        isError: Boolean(ev.is_error),
        costUsd,
        // a run with background tasks ends a result per segment (the CLI resumes it when a task
        // ends), each counting only its own turns: the run's are their sum
        turns: turns !== null ? (state.result?.turns ?? 0) + turns : (state.result?.turns ?? null),
        durationMs: numberOrNull(ev.duration_ms),
        tokens,
      };
      return [`--- result: ${ev.subtype || 'done'} turns=${ev.num_turns ?? '?'} cost=$${(costUsd ?? 0).toFixed(4)} ---`];
    }

    return [];
  }

  function handleLine(line: string): string[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return [trimmed];
    }
    // an array is tolerated like any event the parser doesn't know
    return typeof ev === 'object' && ev !== null ? handle(recordOrEmpty(ev)) : [trimmed];
  }

  return {
    push(chunk: Buffer | string): string[] {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.flatMap(handleLine);
    },
    /** Process any trailing partial line (call once at process close). */
    flush(): string[] {
      const rest = buffer + decoder.end();
      buffer = '';
      return handleLine(rest);
    },
    snapshot(): StreamSnapshot {
      return { ...state, rateLimits: state.rateLimits ? { ...state.rateLimits } : null, subagents: state.subagents.map((a) => ({ ...a })) };
    },
  };
}
