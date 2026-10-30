import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSpecCommands, specRefusal, specState } from '../src/specCommands.ts';
import { GRILL_LOG_MARKER } from '../src/issueGrill.ts';
import type { IssueDetail } from '../src/issuePipeline/githubIssue.ts';

const log = `${GRILL_LOG_MARKER}\n- decision`;

describe('specState', () => {
  const cases: Array<[string, string[], string]> = [
    ['no comments', [], 'not-a-spec'],
    ['only chatter', ['thanks', 'looks fine'], 'not-a-spec'],
    ['one log', ['hi', log], 'to-review'],
    ['several logs', [log, 'edit', `${log} again`], 'to-review'],
  ];
  for (const [name, comments, want] of cases) it(name, () => assert.equal(specState(comments), want));
});

const spec: IssueDetail = { number: 5, title: 'Add X', url: 'https://github.com/o/r/issues/5', state: 'open', labels: ['agent-suggested', 'needs-triage'], comments: [log] };

describe('specRefusal', () => {
  it('accepts a spec to review', () => assert.equal(specRefusal(spec), null));
  it('refuses a closed issue', () => assert.match(specRefusal({ ...spec, state: 'closed' }) ?? '', /closed/));
  it('refuses a missing label', () => assert.match(specRefusal({ ...spec, labels: ['agent-suggested'] }) ?? '', /needs-triage/));
  it('refuses no decision log', () => assert.match(specRefusal({ ...spec, comments: ['hi'] }) ?? '', /decision log/));
});

function setup(issue: IssueDetail) {
  const rejected: number[] = [];
  const commands = createSpecCommands({
    workspaces: { resolveIssueWorkspace: async (alias) => ({ alias: alias ?? 'bot', root: '/ws' }) },
    github: {
      resolveIssueRepo: async () => 'o/r',
      issueDetail: async () => issue,
      rejectIssue: async (_repo, n) => void rejected.push(n),
    },
  });
  return { commands, rejected };
}
const cmd = { kind: 'spec', action: 'reject', issueNumber: 5, alias: 'bot', notes: '' } as const;

describe('spec:reject', () => {
  it('rejects a spec to review and replies with its link', async () => {
    const { commands, rejected } = setup(spec);
    const reply = await commands.reject(cmd);
    assert.deepEqual(rejected, [5]);
    assert.match(reply, /https:\/\/github\.com\/o\/r\/issues\/5/);
  });

  it('changes nothing and says why when the precondition fails', async () => {
    for (const issue of [{ ...spec, state: 'closed' as const }, { ...spec, comments: [] }, { ...spec, labels: ['needs-triage'] }]) {
      const { commands, rejected } = setup(issue);
      const reply = await commands.reject(cmd);
      assert.deepEqual(rejected, []);
      assert.match(reply, /Nothing changed/);
    }
  });

  it('reports a GitHub failure', async () => {
    const commands = createSpecCommands({
      workspaces: { resolveIssueWorkspace: async () => ({ alias: 'bot', root: '/ws' }) },
      github: { resolveIssueRepo: async () => 'o/r', issueDetail: async () => { throw new Error('boom'); }, rejectIssue: async () => {} },
    });
    assert.match(await commands.reject(cmd), /boom/);
  });
});
