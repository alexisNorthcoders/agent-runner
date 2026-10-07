import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFreeformPreamble, buildPreamble } from '../src/preamble.js';

describe('preamble', () => {
  it('points agent restarts at safe-restart in the runner repo', () => {
    const p = buildPreamble({ repoRoot: '/r/agent-runner' });
    assert.match(p, /npm run safe-restart` in \/r\/agent-runner/);
    assert.doesNotMatch(p, /gh pr merge/);
  });

  it('tells the agent long-running jobs are for a human', () => {
    const p = buildPreamble({ repoRoot: '/r/agent-runner' });
    assert.match(p, /long-running work belongs to a human/);
    assert.match(p, /more than about 2 minutes/);
  });

  it('forbids stashing or resetting files the agent did not create', () => {
    const p = buildPreamble({ repoRoot: '/r/agent-runner' });
    assert.match(p, /Never `git stash`/);
    assert.match(p, /files you didn't create/);
  });

  it('adds the commit → PR → review → merge → default-branch rules for freeform runs', () => {
    const p = buildFreeformPreamble({ repoRoot: '/r/agent-runner' });
    assert.ok(p.startsWith(buildPreamble({ repoRoot: '/r/agent-runner' })));
    for (const step of ['gh pr create', 'gh pr diff', 'gh pr merge --squash --delete-branch', 'git status` is clean']) assert.ok(p.includes(step), step);
  });
});
