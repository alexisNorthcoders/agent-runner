import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SUBAGENT_RECENT_MS, applyTranscriptLines, emptyTranscript, subagentCount } from '../src/agentBackend/claudeTranscripts.js';

const T0 = Date.parse('2026-10-06T10:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const base = (s, extra) => ({ sessionId: 's1', cwd: '/home/a/bot', gitBranch: 'main', entrypoint: 'cli', isSidechain: false, timestamp: at(s), ...extra });
const prompt = (s) => JSON.stringify(base(s, { type: 'user', message: { role: 'user', content: 'SECRET prompt text' } }));
const block = (s, b, extra) => JSON.stringify(base(s, { type: 'assistant', message: { role: 'assistant', content: [b] }, ...extra }));
const toolUse = (s, name, input, extra) => block(s, { type: 'tool_use', id: 't', name, input }, extra);
const toolResult = (s) => JSON.stringify(base(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET output' }] } }));
const run = (lines) => applyTranscriptLines(emptyTranscript(), lines);

describe('applyTranscriptLines', () => {
  it('works on a prompt, thinking, a tool call and its result', () => {
    const x = run([prompt(0)]);
    assert.equal(x.state, 'working');
    assert.equal(x.activity, 'writing…');
    assert.equal(x.interactive, true);
    assert.equal(x.cwd, '/home/a/bot');
    assert.equal(x.branch, 'main');
    assert.equal(x.sessionId, 's1');
    assert.equal(x.lastEntryAt, T0);
    run([]);
    applyTranscriptLines(x, [block(1, { type: 'thinking', thinking: 'secret' })]);
    assert.deepEqual([x.state, x.activity], ['working', 'writing…']);
    applyTranscriptLines(x, [toolUse(2, 'Bash', { command: 'npm test' })]);
    assert.deepEqual([x.state, x.activity], ['working', 'Bash: npm test']);
    applyTranscriptLines(x, [toolResult(3)]);
    assert.deepEqual([x.state, x.activity], ['working', 'Bash: npm test']);
  });

  it('waits for the owner after a reply with no tool call after it', () => {
    const x = run([prompt(0), toolUse(1, 'Read', { file_path: '/a/b.js' }), toolResult(2), block(3, { type: 'text', text: 'SECRET reply' })]);
    assert.equal(x.state, 'waiting');
    const both = run([JSON.stringify(base(0, { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }))]);
    assert.equal(both.state, 'working');
    assert.equal(both.activity, 'Bash: ls');
  });

  it('drops a headless run and keeps no prompt or reply text', () => {
    const sdk = run([JSON.stringify(base(0, { type: 'user', entrypoint: 'sdk-cli', message: { content: 'hi' } }))]);
    assert.equal(sdk.interactive, false);
    const x = run([prompt(0), toolResult(1), block(2, { type: 'text', text: 'SECRET reply' })]);
    assert.ok(!JSON.stringify({ ...x, sidechains: [...x.sidechains] }).includes('SECRET'));
  });

  it("counts a subagent's entries, but they never change the state", () => {
    const x = run([prompt(0), block(1, { type: 'text', text: 'done' }), toolUse(5, 'Grep', { pattern: 'x' }, { isSidechain: true, agentId: 'a1' })]);
    assert.equal(x.state, 'waiting');
    assert.equal(x.activity, 'writing…');
    assert.equal(subagentCount(x, T0 + 6000), 0);
    applyTranscriptLines(x, [toolResult(6)]);
    assert.equal(x.state, 'working');
    assert.equal(subagentCount(x, T0 + 6000), 1);
    assert.equal(subagentCount(x, T0 + 5000 + SUBAGENT_RECENT_MS + 1), 0);
  });

  it('skips malformed, unrecognised and incomplete lines without throwing', () => {
    const x = run(['', '{not json', 'null', '"str"', '[1]', JSON.stringify({ type: 'attachment', cwd: '/x' }), JSON.stringify({ type: 'assistant' }), JSON.stringify({ type: 'assistant', message: { content: 'text' } }), prompt(0)]);
    assert.equal(x.cwd, '/home/a/bot');
    assert.equal(x.state, 'working');
    assert.equal(run(['{bad']).state, null);
  });
});
