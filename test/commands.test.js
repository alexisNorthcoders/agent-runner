import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/commands.js';

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
    assert.equal(parseCommand('claude:status please').kind, 'error');
  });

  it('rejects an unknown claude:<word> command', () => {
    const r = parseCommand('claude:frobnicate');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /Unknown command "claude:frobnicate"/);
  });

  it('says issue runs are not supported yet', () => {
    const r = parseCommand('claude issue:42');
    assert.equal(r.kind, 'error');
    assert.match(r.message, /issue:/);
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
