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
