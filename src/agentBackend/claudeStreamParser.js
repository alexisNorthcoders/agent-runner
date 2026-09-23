import { StringDecoder } from 'string_decoder';

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
 *   assistantText: string,
 *   result: null | {
 *     text: string,
 *     isError: boolean,
 *     costUsd: number | null,
 *     turns: number | null,
 *     durationMs: number | null,
 *     tokens: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   },
 * }} StreamSnapshot
 */

export function createStreamAccumulator() {
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
    assistantText: '',
    result: null,
  };
  /** message id -> output tokens (assistant events repeat per content block; count each id once) */
  const outputByMessage = new Map();

  /** @returns {string[]} log lines for this event */
  function handle(ev) {
    if (ev.session_id) state.sessionId = ev.session_id;

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.model) state.model = ev.model;
      return [];
    }

    if (ev.type === 'rate_limit_event') {
      const w = ev.rate_limit_info?.unifiedWindows;
      if (w) {
        state.rateLimits = {
          fiveHour: w.five_hour?.utilization ?? null,
          sevenDay: w.seven_day?.utilization ?? null,
        };
      }
      return [];
    }

    if (ev.type === 'assistant' && ev.message) {
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
        turns: ev.num_turns ?? null,
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
      return { ...state, rateLimits: state.rateLimits ? { ...state.rateLimits } : null };
    },
  };
}
