import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyLogEvent } from '../dashboard/logPane.js';

describe('dashboard log pane', () => {
  const empty = { runId: null, lines: [] };

  it('appends new lines of the run it shows', () => {
    const pane = applyLogEvent(empty, { runId: 'r1', reset: true, lines: ['a'] });
    assert.deepEqual(applyLogEvent(pane, { runId: 'r1', reset: false, lines: ['b', 'c'] }), { runId: 'r1', lines: ['a', 'b', 'c'] });
  });

  it('clears for a new run, or for a reset of the same run (a reconnect)', () => {
    const pane = { runId: 'r1', lines: ['a', 'b'] };
    assert.deepEqual(applyLogEvent(pane, { runId: 'r2', reset: true, lines: ['x'] }), { runId: 'r2', lines: ['x'] });
    assert.deepEqual(applyLogEvent(pane, { runId: 'r1', reset: true, lines: ['b', 'c'] }), { runId: 'r1', lines: ['b', 'c'] });
    assert.deepEqual(applyLogEvent(pane, { runId: 'r2', reset: false, lines: ['y'] }), { runId: 'r2', lines: ['y'] });
  });

  it('keeps only the newest lines', () => {
    const pane = { runId: 'r1', lines: ['a', 'b'] };
    assert.deepEqual(applyLogEvent(pane, { runId: 'r1', reset: false, lines: ['c', 'd'] }, 3).lines, ['b', 'c', 'd']);
  });
});
