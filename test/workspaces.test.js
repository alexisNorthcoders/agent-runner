import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorkspaceAllowlist, parseCompactMap } from '../src/workspaces.js';

describe('parseCompactMap', () => {
  it('parses alias=value pairs and drops malformed ones', () => {
    const m = parseCompactMap(' dots=/a/dots , bad key=/x,=nokey,empty=, ok_2-x=/b ');
    assert.deepEqual([...m], [
      ['dots', '/a/dots'],
      ['ok_2-x', '/b'],
    ]);
  });
});

describe('workspace allowlist', () => {
  let dir;
  let repoA;
  let repoB;
  before(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'agent-ws-')));
    repoA = join(dir, 'repo-a');
    repoB = join(dir, 'repo-b');
    await mkdir(repoA);
    await mkdir(repoB);
    await symlink(repoB, join(dir, 'link-b'));
    await writeFile(join(dir, 'file'), 'x');
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('resolves an alias from the env map to its realpath', async () => {
    const ws = createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `a=${repoA},b=${join(dir, 'link-b')}` } });
    assert.deepEqual(await ws.resolveIssueWorkspace('b'), { alias: 'b', root: repoB });
    assert.deepEqual(await ws.resolveIssueWorkspace('a'), { alias: 'a', root: repoA });
  });

  it('merges the JSON map file over the env map', async () => {
    const file = join(dir, 'map.json');
    await writeFile(file, JSON.stringify({ a: repoB, c: repoA, 'bad key': repoA, n: 5 }));
    const ws = createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `a=${repoA}`, CLAUDE_WORKSPACE_MAP_FILE: file } });
    assert.equal((await ws.resolveIssueWorkspace('a')).root, repoB);
    assert.equal((await ws.resolveIssueWorkspace('c')).root, repoA);
  });

  it('rejects an unknown alias and lists the valid ones', async () => {
    const ws = createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `zed=${repoA},alpha=${repoB}` } });
    await assert.rejects(ws.resolveIssueWorkspace('nope'), /Unknown workspace alias "nope"\. Valid aliases: alpha, zed/);
  });

  it('uses the default alias for issue:<n>, and explains when there is none', async () => {
    const env = { CLAUDE_WORKSPACE_MAP: `bot=${repoA}` };
    assert.deepEqual(await createWorkspaceAllowlist({ env: { ...env, CLAUDE_ISSUE_DEFAULT_ALIAS: 'bot' } }).resolveIssueWorkspace(null), {
      alias: 'bot',
      root: repoA,
    });
    await assert.rejects(createWorkspaceAllowlist({ env }).resolveIssueWorkspace(null), /issue:<alias>:<n>.*CLAUDE_ISSUE_DEFAULT_ALIAS/s);
  });

  it('fails closed on a configured path that is missing or not a directory', async () => {
    await assert.rejects(
      createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `a=${join(dir, 'missing')}` } }).resolveIssueWorkspace('a'),
      /does not exist/
    );
    await assert.rejects(
      createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `a=${join(dir, 'file')}` } }).resolveIssueWorkspace('a'),
      /Not a directory/
    );
  });

  it('reports an unreadable or invalid map file', async () => {
    await assert.rejects(
      createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP_FILE: join(dir, 'nope.json') } }).resolveIssueWorkspace('a'),
      /CLAUDE_WORKSPACE_MAP_FILE: cannot read/
    );
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{');
    await assert.rejects(
      createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP_FILE: bad } }).resolveIssueWorkspace('a'),
      /invalid JSON/
    );
  });

  it('does not treat inherited object keys as aliases', async () => {
    const ws = createWorkspaceAllowlist({ env: { CLAUDE_WORKSPACE_MAP: `a=${repoA}` } });
    await assert.rejects(ws.resolveIssueWorkspace('constructor'), /Unknown workspace alias/);
  });
});
