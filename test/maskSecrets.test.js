import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets } from '../src/maskSecrets.js';

describe('maskSecrets', () => {
  /** @type {[string, string, string][]} name, line, masked */
  const cases = [
    ['GitHub classic token', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok', 'token ghp_*** ok'],
    ['GitHub OAuth token', 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'gho_***'],
    ['GitHub fine-grained token', 'x github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz y', 'x github_pat_*** y'],
    ['API key', 'key: sk-ant-api03-AbCdEf0123456789_-xyzXYZ done', 'key: sk-*** done'],
    ['API key inside JSON', '[out] {"text":"sk-proj-abcdefghijklmnop1234"}', '[out] {"text":"sk-***"}'],
    ['bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc', 'Authorization: Bearer ***'],
    ['bearer token, any case', 'authorization: bearer abcdef123456', 'authorization: bearer ***'],
    ['_KEY assignment', 'OPENAI_API_KEY=abc123 node x', 'OPENAI_API_KEY=*** node x'],
    ['_TOKEN assignment, quoted', 'export GH_TOKEN="abc 123"', 'export GH_TOKEN="***"'],
    ['_SECRET assignment, JSON-escaped quotes', '{"cmd":"CLIENT_SECRET=\\"s3cr3t\\" run"}', '{"cmd":"CLIENT_SECRET=\\"***\\" run"}'],
    ['_PASSWORD assignment, single quotes', "DB_PASSWORD='hunter2' psql", "DB_PASSWORD='***' psql"],
    ['lowercase assignment', 'smtp_password=hunter2', 'smtp_password=***'],
    ['several secrets on one line', 'A_TOKEN=x B_KEY=y ghp_abcdefghijklmnopqrstuvwxyz0123', 'A_TOKEN=*** B_KEY=*** ghp_***'],
  ];
  for (const [name, line, masked] of cases) {
    it(`masks: ${name}`, () => assert.equal(maskSecrets(line), masked));
  }

  /** @type {[string, string][]} */
  const untouched = [
    ['plain text', 'Read src/a.js and ran npm test'],
    ['words ending in sk-', 'the task-runner and a desk-lamp'],
    ['short sk- ids', 'sk-1 and sk-abc'],
    ['a comparison, not an assignment', 'if (API_KEY == null) return'],
    ['an empty assignment', 'GH_TOKEN= npm test'],
    ['a key name without a value', 'set the ANTHROPIC_API_KEY variable'],
    ['the word bearer on its own', 'the bearer of bad news'],
  ];
  for (const [name, line] of untouched) {
    it(`leaves alone: ${name}`, () => assert.equal(maskSecrets(line), line));
  }
});
