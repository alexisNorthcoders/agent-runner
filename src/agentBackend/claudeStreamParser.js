import { StringDecoder } from 'string_decoder';
import { createToolTouchReader } from './claudeToolTouch.js';

/**
 * Incremental parser for `claude -p --output-format stream-json --verbose` output (NDJSON).
 * Pure: feed it stdout chunks, get back human-readable log lines and a snapshot of what the
 * run is doing / has cost so far. Unknown or malformed lines are tolerated (returned verbatim).
 */

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * Short "what is the agent doing" label for a tool_use block, e.g. `Bash: git status`.
 * @param {string} name
 * @param {Record<string, unknown>} [input]
 */
export function describeToolUse(name, input = {}) {
  const pick =
    input.command ?? input.file_path ?? input.pattern ?? input.skill ?? input.description ?? input.url ?? input.query;
  return pick == null ? String(name) : `${name}: ${truncate(pick, 80)}`;
}

function sumModelUsage(modelUsage) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  for (const u of Object.values(modelUsage || {})) {
    totals.input += u.inputTokens || 0;
    totals.output += u.outputTokens || 0;
    totals.cacheRead += u.cacheReadInputTokens || 0;
    totals.cacheCreate += u.cacheCreationInputTokens || 0;
  }
  return totals;
}

/** Model that accounted for the most spend (falls back to the first listed). */
function primaryModel(modelUsage) {
  const entries = Object.entries(modelUsage || {});
  if (!entries.length) return null;
  return entries.reduce((a, b) => ((b[1].costUSD || 0) > (a[1].costUSD || 0) ? b : a))[0];
}

/**
 * @typedef {{
 *   model: string | null,
 *   sessionId: string | null,
 *   turns: number,
 *   outputTokens: number,
 *   contextTokens: number,
 *   lastActivity: string | null,
 *   rateLimits: { fiveHour: number | null, sevenDay: number | null } | null,
 *   rejectedResetsAt: number | null,
 *   rateLimited: boolean,
 *   assistantText: string,
 *   subagents: import('./index.js').AgentSubagent[],
 *   result: null | {
 *     text: string,
 *     isError: boolean,
 *     costUsd: number | null,
 *     turns: number | null,
 *     durationMs: number | null,
 *     tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   },
 * }} StreamSnapshot
 *   `rejectedResetsAt` is the reset epoch of a rate-limit event that rejected the run (the usage
 *   limit), when one came. `rateLimited` is whether the stream signalled the usage limit: that
 *   rejected event, or the CLI's synthetic assistant message flagged `error: "rate_limit"`.
 *   `subagents`: the subagents running now, oldest first. Their messages (tagged with the
 *   `parent_tool_use_id` of the tool call that spawned them) count toward `outputTokens` but not
 *   the main agent's `turns`, `contextTokens` or `lastActivity`, and their log lines are prefixed
 *   with their description.
 */

/** The tool calls that spawn a subagent (the CLI's older and newer names for it). */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
/** A task's statuses once it's over. */
const TASK_OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'error']);

/**
 * @param {{ cwd?: string, onTouch?: (t: import('./index.js').AgentTouch) => void }} [o] `onTouch`
 *   hears each edit or command tool call (./claudeToolTouch.js), read from `cwd`.
 */
export function createStreamAccumulator({ cwd = process.cwd(), onTouch } = {}) {
  const touches = onTouch ? createToolTouchReader({ cwd }) : null;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  /** @type {StreamSnapshot} */
  const state = {
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
  const outputByMessage = new Map();
  /** A background task's id -> the tool call (its subagent's id) that spawned it. @type {Map<string, string>} */
  const taskTool = new Map();

  /** @param {string} id */
  const subagent = (id) => state.subagents.find((a) => a.id === id);
  /** A subagent spawned by tool call `id`, unless it's already known. @param {string} id @param {{ description?: unknown, subagent_type?: unknown }} input */
  function spawned(id, input) {
    const known = subagent(id);
    const description = typeof input.description === 'string' && input.description.trim() ? truncate(input.description, 60) : 'subagent';
    const type = typeof input.subagent_type === 'string' ? input.subagent_type : null;
    if (known) {
      known.description = description;
      known.type = type ?? known.type;
    } else state.subagents = [...state.subagents, { id, description, type, activity: null }];
  }
  /** The subagent spawned by tool call `id` is done. @param {string | undefined} id */
  function finished(id) {
    if (id) state.subagents = state.subagents.filter((a) => a.id !== id);
  }

  /**
   * A subagent's message: its output tokens count, its tool calls and text are its own activity,
   * and its log lines say whose they are. One the parser never saw spawned is picked up here.
   * @returns {string[]}
   */
  function subagentSays(ev) {
    const m = ev.message;
    if (m.id && m.usage) {
      outputByMessage.set(m.id, m.usage.output_tokens || 0);
      state.outputTokens = [...outputByMessage.values()].reduce((a, b) => a + b, 0);
    }
    if (!subagent(ev.parent_tool_use_id)) spawned(ev.parent_tool_use_id, { description: ev.task_description, subagent_type: ev.subagent_type });
    const who = /** @type {import('./index.js').AgentSubagent} */ (subagent(ev.parent_tool_use_id));
    const lines = [];
    for (const block of m.content || []) {
      if (block.type === 'tool_use') {
        who.activity = describeToolUse(block.name, block.input);
        lines.push(`[${who.description}] → ${who.activity}`);
        // a subagent spawning its own
        if (SPAWN_TOOLS.has(block.name) && typeof block.id === 'string') spawned(block.id, block.input ?? {});
      } else if (block.type === 'text' && block.text?.trim()) {
        who.activity = 'writing…';
        lines.push(`[${who.description}] ${truncate(block.text, 300)}`);
      }
    }
    return lines;
  }

  /** @returns {string[]} log lines for this event */
  function handle(ev) {
    if (ev.session_id) state.sessionId = ev.session_id;

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.model) state.model = ev.model;
      return [];
    }

    if (ev.type === 'system' && ev.subtype === 'task_started' && typeof ev.tool_use_id === 'string') {
      if (typeof ev.task_id === 'string') taskTool.set(ev.task_id, ev.tool_use_id);
      spawned(ev.tool_use_id, ev);
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'task_updated' && TASK_OVER.has(ev.patch?.status)) {
      finished(taskTool.get(ev.task_id));
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'task_notification') {
      finished(typeof ev.tool_use_id === 'string' ? ev.tool_use_id : taskTool.get(ev.task_id));
      return [];
    }
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
      // a background subagent no longer listed is over, however its end was missed
      const live = new Set(ev.tasks.map((x) => taskTool.get(x?.task_id)).filter(Boolean));
      const background = new Set(taskTool.values());
      state.subagents = state.subagents.filter((a) => !background.has(a.id) || live.has(a.id));
      return [];
    }

    // a foreground subagent's tool call returns when it's done (a background one's straight away, launched)
    if (ev.type === 'user' && !ev.parent_tool_use_id && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type !== 'tool_result' || !subagent(block.tool_use_id)) continue;
        if (ev.tool_use_result?.status === 'async_launched' || ev.tool_use_result?.isAsync) continue;
        finished(block.tool_use_id);
      }
      return [];
    }

    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info;
      if (info?.status === 'rejected') {
        state.rateLimited = true;
        if (typeof info.resetsAt === 'number') state.rejectedResetsAt = info.resetsAt;
      }
      const w = info?.unifiedWindows;
      if (w) {
        state.rateLimits = {
          fiveHour: w.five_hour?.utilization ?? null,
          sevenDay: w.seven_day?.utilization ?? null,
        };
      }
      return [];
    }

    if (ev.type === 'assistant' && ev.message && typeof ev.parent_tool_use_id === 'string') return subagentSays(ev);

    if (ev.type === 'assistant' && ev.message) {
      if (ev.error === 'rate_limit') state.rateLimited = true;
      const m = ev.message;
      if (m.model) state.model = m.model;
      if (m.id && !outputByMessage.has(m.id)) state.turns += 1;
      if (m.id && m.usage) {
        outputByMessage.set(m.id, m.usage.output_tokens || 0);
        state.outputTokens = [...outputByMessage.values()].reduce((a, b) => a + b, 0);
        const ctx =
          (m.usage.input_tokens || 0) +
          (m.usage.cache_read_input_tokens || 0) +
          (m.usage.cache_creation_input_tokens || 0);
        // later events for the same message can carry only output_tokens; keep the last real context size
        if (ctx > 0) state.contextTokens = ctx;
      }
      const lines = [];
      for (const block of m.content || []) {
        if (block.type === 'tool_use') {
          state.lastActivity = describeToolUse(block.name, block.input);
          lines.push(`→ ${state.lastActivity}`);
          if (SPAWN_TOOLS.has(block.name) && typeof block.id === 'string') spawned(block.id, block.input ?? {});
          const touch = touches?.read(block.name, block.input);
          if (touch) onTouch?.(touch);
        } else if (block.type === 'text' && block.text?.trim()) {
          state.assistantText = block.text;
          state.lastActivity = 'writing…';
          lines.push(`assistant: ${truncate(block.text, 500)}`);
        }
      }
      return lines;
    }

    if (ev.type === 'result') {
      const tokens = ev.modelUsage
        ? sumModelUsage(ev.modelUsage)
        : {
            input: ev.usage?.input_tokens || 0,
            output: ev.usage?.output_tokens || 0,
            cacheRead: ev.usage?.cache_read_input_tokens || 0,
            cacheCreate: ev.usage?.cache_creation_input_tokens || 0,
          };
      state.model = primaryModel(ev.modelUsage) ?? state.model;
      state.result = {
        text: typeof ev.result === 'string' ? ev.result : '',
        isError: Boolean(ev.is_error),
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        // a run with background tasks ends a result per segment (the CLI resumes it when a task
        // ends), each counting only its own turns: the run's are their sum
        turns: typeof ev.num_turns === 'number' ? (state.result?.turns ?? 0) + ev.num_turns : (state.result?.turns ?? null),
        durationMs: ev.duration_ms ?? null,
        tokens,
      };
      return [
        `--- result: ${ev.subtype || 'done'} turns=${ev.num_turns ?? '?'} cost=$${(ev.total_cost_usd ?? 0).toFixed(4)} ---`,
      ];
    }

    return [];
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return [trimmed];
    }
    return ev && typeof ev === 'object' ? handle(ev) : [trimmed];
  }

  return {
    /** @param {Buffer | string} chunk @returns {string[]} */
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      return parts.flatMap(handleLine);
    },
    /** Process any trailing partial line (call once at process close). @returns {string[]} */
    flush() {
      const rest = buffer + decoder.end();
      buffer = '';
      return handleLine(rest);
    },
    /** @returns {StreamSnapshot} */
    snapshot() {
      return { ...state, rateLimits: state.rateLimits ? { ...state.rateLimits } : null, subagents: state.subagents.map((a) => ({ ...a })) };
    },
  };
}
