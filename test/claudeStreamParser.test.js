import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createStreamAccumulator, describeToolUse } from '../src/agentBackend/claudeStreamParser.js';

const line = (o) => `${JSON.stringify(o)}\n`;

describe('claudeStreamParser', () => {
  it('tracks model, turns, activity, tokens and the final result', () => {
    const acc = createStreamAccumulator();
    acc.push(line({ type: 'system', subtype: 'init', model: 'claude-opus-5', session_id: 's1' }));
    const lines = acc.push(
      line({
        type: 'assistant',
        message: {
          id: 'm1',
          model: 'claude-opus-5',
          usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 },
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }],
        },
      })
    );
    assert.deepEqual(lines, ['→ Bash: git status']);
    // same message id repeated per content block must not double count
    acc.push(
      line({
        type: 'assistant',
        message: { id: 'm1', usage: { output_tokens: 9 }, content: [{ type: 'text', text: 'done' }] },
      })
    );
    acc.push(line({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.7 } } } }));
    acc.push(
      line({
        type: 'result',
        subtype: 'success',
        result: 'All done',
        total_cost_usd: 1.25,
        num_turns: 3,
        duration_ms: 5000,
        modelUsage: {
          'claude-opus-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40, costUSD: 1.2 },
          'claude-haiku-4-5-20251001': { inputTokens: 1, outputTokens: 1, costUSD: 0.05 },
        },
      })
    );
    const s = acc.snapshot();
    assert.equal(s.sessionId, 's1');
    assert.equal(s.turns, 1);
    assert.equal(s.outputTokens, 9);
    assert.equal(s.contextTokens, 115);
    assert.deepEqual(s.rateLimits, { fiveHour: 0.4, sevenDay: 0.7 });
    assert.equal(s.model, 'claude-opus-5');
    assert.equal(s.result.text, 'All done');
    assert.equal(s.result.costUsd, 1.25);
    assert.deepEqual(s.result.tokens, { input: 11, output: 21, cacheRead: 30, cacheCreate: 40 });
  });

  it('remembers a rejected rate-limit event and its reset epoch', () => {
    const acc = createStreamAccumulator();
    assert.equal(acc.snapshot().rejectedResetsAt, null);
    acc.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1 } }));
    assert.equal(acc.snapshot().rejectedResetsAt, null);
    assert.equal(acc.snapshot().rateLimited, false);
    acc.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1789517400, rateLimitType: 'five_hour' } }));
    assert.equal(acc.snapshot().rejectedResetsAt, 1789517400);
    assert.equal(acc.snapshot().rateLimited, true);
  });

  it("flags the CLI's rate-limit error message as the usage limit", () => {
    const acc = createStreamAccumulator();
    acc.push(line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: "You've hit your session limit" }] } }));
    assert.equal(acc.snapshot().rateLimited, false, 'the text alone is not the signal');
    acc.push(line({ type: 'assistant', error: 'rate_limit', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } }));
    assert.equal(acc.snapshot().rateLimited, true);
  });

  it('reassembles lines split across chunks, including multi-byte characters', () => {
    const acc = createStreamAccumulator();
    const buf = Buffer.from(line({ type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'héllo' }] } }));
    const cut = buf.indexOf(0xc3) + 1; // split inside "é"
    assert.deepEqual(acc.push(buf.subarray(0, cut)), []);
    assert.equal(acc.push(buf.subarray(cut)).length, 1);
    assert.equal(acc.snapshot().assistantText, 'héllo');
  });

  it('passes non-JSON lines through and flushes a trailing partial line', () => {
    const acc = createStreamAccumulator();
    assert.deepEqual(acc.push('warning: something\n'), ['warning: something']);
    acc.push('{"type":"result","result":"tail","subtype":"success"}');
    assert.equal(acc.snapshot().result, null);
    acc.flush();
    assert.equal(acc.snapshot().result.text, 'tail');
  });

  it('describes tool uses compactly', () => {
    assert.equal(describeToolUse('Read', { file_path: '/a/b.js' }), 'Read: /a/b.js');
    assert.equal(describeToolUse('TaskList', {}), 'TaskList');
    assert.equal(describeToolUse('Bash', { command: 'x'.repeat(200) }).length, 'Bash: '.length + 80);
  });
});

describe('claudeStreamParser: subagents', () => {
  /** The main agent spawning a subagent by tool call `id`. */
  const spawn = (msg, id, description) => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: msg, usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 5 }, content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'p', subagent_type: 'general-purpose' } }] },
  });
  const started = (taskId, id, description) => ({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: id, description, subagent_type: 'general-purpose', is_backgrounded: true, task_type: 'local_agent' });
  const launched = (id) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id }] }, tool_use_result: { isAsync: true, status: 'async_launched' } });
  /** A subagent's message: its own tool call or text. */
  const says = (parent, msg, block, description) => ({
    type: 'assistant',
    parent_tool_use_id: parent,
    task_description: description,
    subagent_type: 'general-purpose',
    message: { id: msg, usage: { input_tokens: 3, cache_read_input_tokens: 50_000, output_tokens: 20 }, content: [block] },
  });

  it('tracks background subagents from spawn to done, apart from the main agent', () => {
    const acc = createStreamAccumulator();
    acc.push(line(spawn('m1', 'tu1', 'Spec review')) + line(started('task1', 'tu1', 'Spec review')) + line(launched('tu1')));
    acc.push(line(spawn('m1', 'tu2', 'Standards review')) + line(started('task2', 'tu2', 'Standards review')) + line(launched('tu2')));
    let s = acc.snapshot();
    assert.deepEqual(s.subagents, [
      { id: 'tu1', description: 'Spec review', type: 'general-purpose', activity: null },
      { id: 'tu2', description: 'Standards review', type: 'general-purpose', activity: null },
    ]);
    assert.equal(s.lastActivity, 'Agent: Standards review');

    const lines = acc.push(line(says('tu1', 's1', { type: 'tool_use', name: 'Bash', input: { command: 'git diff' } }, 'Spec review')));
    assert.deepEqual(lines, ['[Spec review] → Bash: git diff']);
    s = acc.snapshot();
    assert.equal(s.subagents[0].activity, 'Bash: git diff');
    // the main agent's own figures stay its own
    assert.deepEqual([s.turns, s.contextTokens, s.lastActivity], [1, 1010, 'Agent: Standards review']);
    assert.equal(s.outputTokens, 25, 'but the subagent output counts');

    acc.push(line({ type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'completed', end_time: 1 } }));
    assert.deepEqual(acc.snapshot().subagents.map((a) => a.id), ['tu2']);
    acc.push(line({ type: 'system', subtype: 'task_notification', task_id: 'task2', tool_use_id: 'tu2', status: 'completed', summary: 'ok' }));
    assert.deepEqual(acc.snapshot().subagents, []);
  });

  it('drops a background subagent no longer listed, however its end was missed', () => {
    const acc = createStreamAccumulator();
    acc.push(line(spawn('m1', 'tu1', 'A')) + line(started('task1', 'tu1', 'A')) + line(spawn('m1', 'tu2', 'B')) + line(started('task2', 'tu2', 'B')));
    acc.push(line({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'task2', task_type: 'local_agent' }] }));
    assert.deepEqual(acc.snapshot().subagents.map((a) => a.id), ['tu2']);
  });

  it('ends a foreground subagent when its tool call returns', () => {
    const acc = createStreamAccumulator();
    acc.push(line(spawn('m1', 'tu1', 'Explore')));
    acc.push(line(says('tu1', 's1', { type: 'text', text: 'found it' }, 'Explore')));
    assert.equal(acc.snapshot().subagents[0].activity, 'writing…');
    acc.push(line({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'found it' }] } }));
    assert.deepEqual(acc.snapshot().subagents, []);
  });

  it("picks up a subagent it never saw spawned from its messages, and a subagent's own", () => {
    const acc = createStreamAccumulator();
    acc.push(line(says('tuX', 's1', { type: 'tool_use', id: 'tuY', name: 'Task', input: { description: 'Nested' } }, 'Outer')));
    assert.deepEqual(acc.snapshot().subagents.map((a) => [a.id, a.description]), [['tuX', 'Outer'], ['tuY', 'Nested']]);
  });

  it('copies the subagents out, so a snapshot never changes after the fact', () => {
    const acc = createStreamAccumulator();
    acc.push(line(spawn('m1', 'tu1', 'A')));
    const before = acc.snapshot();
    acc.push(line(says('tu1', 's1', { type: 'text', text: 'hi' }, 'A')));
    assert.equal(before.subagents[0].activity, null);
  });
});
