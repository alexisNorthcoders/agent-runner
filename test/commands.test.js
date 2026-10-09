import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, USAGE } from '../src/commands.js';

describe('parseCommand', () => {
  it('parses a freeform instruction', () => {
    assert.deepEqual(parseCommand('claude add a README section'), {
      kind: 'freeform',
      prompt: 'add a README section',
    });
  });

  it('keeps multi-line instructions intact and is case-insensitive on the prefix', () => {
    assert.deepEqual(parseCommand('Claude  fix the bug\n\nthen add tests  '), {
      kind: 'freeform',
      prompt: 'fix the bug\n\nthen add tests',
    });
  });

  it('tolerates "claude: <instructions>"', () => {
    assert.deepEqual(parseCommand('claude: check disk space'), {
      kind: 'freeform',
      prompt: 'check disk space',
    });
  });

  it('parses a model prefix on freeform and Joplin requests', () => {
    assert.deepEqual(parseCommand('claude haiku: restart pm2'), { kind: 'freeform', prompt: 'restart pm2', model: 'haiku' });
    assert.deepEqual(parseCommand('claude Opus :refactor the queue'), { kind: 'freeform', prompt: 'refactor the queue', model: 'opus' });
    assert.deepEqual(parseCommand('claude SONNET:  x'), { kind: 'freeform', prompt: 'x', model: 'sonnet' });
    assert.deepEqual(parseCommand('claude opus: joplin:my-note'), { kind: 'joplin', noteQuery: 'my-note', model: 'opus' });
  });

  it('leaves anything that is not a model prefix in the prompt', () => {
    assert.deepEqual(parseCommand('claude opus rocks'), { kind: 'freeform', prompt: 'opus rocks' });
    assert.deepEqual(parseCommand('claude gpt: fix it'), { kind: 'freeform', prompt: 'gpt: fix it' });
  });

  it('rejects a model prefix in front of issue: or with nothing after it', () => {
    assert.match(/** @type {any} */ (parseCommand('claude opus: issue:12')).message, /issue runs/);
    assert.equal(parseCommand('claude opus: issue:a:12').kind, 'error');
    assert.equal(parseCommand('claude haiku:').kind, 'error');
  });

  it('documents the prefix in the usage', () => {
    assert.match(USAGE, /haiku\|sonnet\|opus:/);
  });

  it('parses joplin:<note>', () => {
    assert.deepEqual(parseCommand('claude joplin: refactor plan '), {
      kind: 'joplin',
      noteQuery: 'refactor plan',
    });
  });

  it('rejects joplin: with no note', () => {
    const r = parseCommand('claude joplin:');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /joplin:<note/);
  });

  it('parses claude:stop and claude:restart, case-insensitively', () => {
    assert.deepEqual(parseCommand('claude:stop'), { kind: 'stop' });
    assert.deepEqual(parseCommand(' Claude:Restart '), { kind: 'restart' });
  });

  it('treats claude:stop/restart with trailing words as the subcommand, never a freeform run', () => {
    assert.deepEqual(parseCommand('claude:stop now please'), { kind: 'stop' });
    assert.deepEqual(parseCommand('claude:restart\nthanks'), { kind: 'restart' });
    assert.deepEqual(parseCommand('claude:status please'), { kind: 'status' });
  });

  it('parses claude:status and claude:history [n]', () => {
    assert.deepEqual(parseCommand('claude:status'), { kind: 'status' });
    assert.deepEqual(parseCommand('claude:history'), { kind: 'history', count: 10 });
    assert.deepEqual(parseCommand('claude:history 3'), { kind: 'history', count: 3 });
    assert.deepEqual(parseCommand('claude:history 500'), { kind: 'history', count: 30 });
  });

  it('parses claude:queue [clear]', () => {
    assert.deepEqual(parseCommand('claude:queue'), { kind: 'queue', clear: false });
    assert.deepEqual(parseCommand('claude:queue CLEAR'), { kind: 'queue', clear: true });
    assert.equal(parseCommand('claude:queue everything').kind, 'error');
  });

  it('rejects a bad claude:history count', () => {
    for (const t of ['claude:history 0', 'claude:history lots', 'claude:history -2']) {
      const r = parseCommand(t);
      assert.equal(r.kind, 'error', t);
      assert.match(r.message, /claude:history \[n\]/);
    }
  });

  it('rejects an unknown claude:<word> command', () => {
    const r = parseCommand('claude:frobnicate');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /Unknown command "claude:frobnicate"/);
  });

  it('parses issue:<n> with no alias', () => {
    assert.deepEqual(parseCommand('claude issue:42'), {
      kind: 'issue',
      issueNumber: 42,
      alias: null,
      extraInstructions: '',
    });
  });

  it('parses issue:<alias>:<n> with extra instructions', () => {
    assert.deepEqual(parseCommand('claude issue: platformer : 123 add unit tests\nand docs'), {
      kind: 'issue',
      issueNumber: 123,
      alias: 'platformer',
      extraInstructions: 'add unit tests\nand docs',
    });
  });

  it('rejects a malformed issue command instead of running it as freeform', () => {
    for (const text of ['claude issue:', 'claude issue:abc', 'claude issue:0', 'claude issue:x:y']) {
      const r = parseCommand(text);
      assert.equal(r.kind, 'error', text);
      assert.match(r.message, /issue:<n>/);
    }
  });

  it('returns usage for a bare "claude"', () => {
    const r = parseCommand('claude');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /^Usage:/);
  });

  it('rejects text that does not start with the claude command', () => {
    assert.equal(parseCommand('hello').kind, 'error');
    assert.equal(parseCommand('claudette do it').kind, 'error');
    assert.equal(parseCommand('').kind, 'error');
    assert.equal(parseCommand(/** @type {any} */ (undefined)).kind, 'error');
  });
});

describe('parseCommand: pause / resume', () => {
  it('reads an optional scope, duration and reason, defaulting to everything for 2h', () => {
    assert.deepEqual(parseCommand('claude:pause'), { kind: 'pause', scope: 'all', seconds: 7200, reason: '' });
    assert.deepEqual(parseCommand('claude:pause 30m lunch break'), { kind: 'pause', scope: 'all', seconds: 1800, reason: 'lunch break' });
    assert.deepEqual(parseCommand('claude:pause Chess-Trainer 1d'), { kind: 'pause', scope: 'chess-trainer', seconds: 86400, reason: '' });
    assert.deepEqual(parseCommand('claude:pause bot fixing it'), { kind: 'pause', scope: 'bot', seconds: 7200, reason: 'fixing it' });
  });

  it('refuses more than 7 days', () => {
    assert.equal(parseCommand('claude:pause 8d').kind, 'error');
  });

  it('resumes one scope, or every pause with none', () => {
    assert.deepEqual(parseCommand('claude:resume'), { kind: 'resume', scope: null });
    assert.deepEqual(parseCommand('claude:resume bot'), { kind: 'resume', scope: 'bot' });
    assert.equal(parseCommand('claude:resume bot now').kind, 'error');
  });
});

describe('parseCommand: claude:more', () => {
  it('keeps all the text after claude:more as the instructions', () => {
    assert.deepEqual(parseCommand('claude:more now add tests\nand docs'), { kind: 'more', instructions: 'now add tests\nand docs' });
    assert.deepEqual(parseCommand('Claude:MORE   fix it  '), { kind: 'more', instructions: 'fix it' });
  });

  it('gives the usage for empty instructions, and lists the command in USAGE', () => {
    for (const t of ['claude:more', 'claude:more   ']) {
      const c = parseCommand(t);
      assert.equal(c.kind, 'error');
      assert.match(/** @type {any} */ (c).message, /^Usage: claude:more <instructions>/);
    }
    assert.match(USAGE, /^claude:more <instructions>/m);
  });
});
