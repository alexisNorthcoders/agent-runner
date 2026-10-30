import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSpecCommands, specRefusal, specState } from '../src/specCommands.ts';
import { GRILL_LOG_MARKER } from '../src/issueGrill.ts';
import type { IssueDetail } from '../src/issuePipeline/githubIssue.ts';

const log = `${GRILL_LOG_MARKER}\n- decision`;
const proposal = (n: number) => `Ticket proposal (draft ${n})\n\n## Tickets`;

describe('specState', () => {
  const cases: Array<[string, string[], string]> = [
    ['no comments', [], 'not-a-spec'],
    ['only chatter', ['thanks', 'looks fine'], 'not-a-spec'],
    ['one log', ['hi', log], 'to-review'],
    ['several logs', [log, 'edit', `${log} again`], 'to-review'],
    ['proposal after grill', [log, 'ok', proposal(1)], 'breakdown-to-approve'],
    ['re-grill after proposal', [log, proposal(1), 'tweak it', log], 'to-review'],
    ['several proposals', [log, proposal(1), proposal(2)], 'breakdown-to-approve'],
    ['proposal then re-grill then proposal', [log, proposal(1), log, proposal(2)], 'breakdown-to-approve'],
    ['proposal with no decision log', [proposal(1)], 'not-a-spec'],
    ['marker quoted mid-comment', [log, 'see Ticket proposal (draft 1)'], 'to-review'],
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

describe('spec:approve and spec:revise preconditions', () => {
  const run = (action: 'approve' | 'revise', issue: IssueDetail) =>
    setup(issue).commands.prepare({ kind: 'spec', action, issueNumber: 5, alias: 'bot', notes: 'fewer tickets' });
  const proposed: IssueDetail = { ...spec, comments: [log, proposal(1)], commentUrls: ['u/1', 'u/2'] };

  it('approve on a spec to review builds a /draft-tickets run', async () => {
    const r = await run('approve', spec);
    assert.ok(typeof r !== 'string');
    assert.equal(r.prompt, '/draft-tickets https://github.com/o/r/issues/5');
    assert.equal(r.proposalsBefore, 0);
  });

  it('revise on a breakdown to approve passes the notes', async () => {
    const r = await run('revise', proposed);
    assert.ok(typeof r !== 'string');
    assert.equal(r.prompt, '/draft-tickets https://github.com/o/r/issues/5 fewer tickets');
    assert.equal(r.proposalsBefore, 1);
  });

  it('refuses approve on a breakdown to approve and names revise', async () => {
    const r = await run('approve', proposed);
    assert.match(String(r), /Not approved.*breakdown to approve.*claude spec:revise:bot:5.*Nothing changed/);
  });

  it('refuses revise on a spec to review and names approve', async () => {
    const r = await run('revise', spec);
    assert.match(String(r), /Not revised.*spec to review.*claude spec:approve:bot:5.*Nothing changed/);
  });

  const orders: Array<[string, string[], 'approve' | 'revise']> = [
    ['log, proposal, chatter', [log, proposal(1), 'thanks'], 'revise'],
    ['several proposals', [log, proposal(1), proposal(2)], 'revise'],
    ['re-grill after proposal', [log, proposal(1), log], 'approve'],
    ['re-grill after several proposals', [log, proposal(1), proposal(2), 'tweak', log], 'approve'],
    ['proposal after re-grill', [log, proposal(1), log, proposal(2)], 'revise'],
    ['re-grill, proposal, re-grill', [log, proposal(1), log, proposal(2), log], 'approve'],
  ];
  for (const [name, comments, fits] of orders) {
    const other = fits === 'approve' ? 'revise' : 'approve';
    it(`${name}: ${fits} runs, ${other} is refused naming ${fits}`, async () => {
      const issue = { ...spec, comments };
      assert.ok(typeof (await run(fits, issue)) !== 'string');
      assert.match(String(await run(other, issue)), /Nothing changed/);
      assert.match(String(await run(other, issue)), new RegExp(`claude spec:${fits}:bot:5`));
    });
  }

  it('landed is the new proposal comment link, and null without a new proposal', async () => {
    const before = await run('revise', proposed);
    assert.ok(typeof before !== 'string');
    const after = setup({ ...proposed, comments: [log, proposal(1), proposal(2)], commentUrls: ['u/1', 'u/2', 'u/3'] });
    assert.equal(await after.commands.landed(before), 'u/3');
    assert.equal(await setup(proposed).commands.landed(before), null);
  });
});

describe('spec:publish', () => {
  const run = (issue: IssueDetail) => setup(issue).commands.prepare({ kind: 'spec', action: 'publish', issueNumber: 5, alias: 'bot', notes: '' });
  const twoTickets = 'Ticket proposal (draft 1)\n\n## Tickets\n\n### 1. A\n\n### 2. B\n\n## Reasoning';
  const record = (...rows: string[]) => ['Published tickets', 'From: Ticket proposal (draft 1)', '', ...rows].join('\n');
  const proposed: IssueDetail = { ...spec, comments: [log, twoTickets] };

  it('builds a /publish-tickets run on sonnet for a breakdown to approve', async () => {
    const r = await run(proposed);
    assert.ok(typeof r !== 'string');
    assert.equal(r.prompt, '/publish-tickets https://github.com/o/r/issues/5');
    assert.equal(r.model, 'sonnet');
  });

  it('refuses a spec with no proposal and says to approve', async () => {
    assert.match(String(await run(spec)), /no Ticket proposal.*claude spec:approve:bot:5.*Nothing changed/);
    assert.match(String(await run({ ...spec, comments: [log, twoTickets, log] })), /claude spec:approve:bot:5/);
  });

  it('refuses a comment after the proposal and says to revise', async () => {
    assert.match(String(await run({ ...proposed, comments: [log, twoTickets, 'make it one ticket'] })), /commented after.*claude spec:revise:bot:5.*Nothing changed/);
  });

  it('accepts a retry whose only later comment is its own record', async () => {
    assert.ok(typeof (await run({ ...proposed, comments: [log, twoTickets, record('- 1: #8')] })) !== 'string');
  });

  it('refuses a later comment even beside its own record, and a record of another draft', async () => {
    const stale = record('- 1: #8').replace('draft 1', 'draft 2');
    assert.match(String(await run({ ...proposed, comments: [log, twoTickets, record('- 1: #8'), 'one more thing'] })), /commented after/);
    assert.match(String(await run({ ...proposed, comments: [log, twoTickets, stale] })), /commented after/);
  });

  it('landed links every proposed ticket, and is null with a gap, no record or another draft', async () => {
    const before = await run(proposed);
    assert.ok(typeof before !== 'string');
    const landed = (comments: string[]) => setup({ ...proposed, comments }).commands.landed(before);
    assert.equal(await landed([log, twoTickets, record('- 1: #8', '- 2: #9')]), '1. https://github.com/o/r/issues/8\n2. https://github.com/o/r/issues/9');
    assert.equal(await landed([log, twoTickets, record('- 1: #8')]), null);
    assert.equal(await landed([log, twoTickets]), null);
    assert.equal(await landed([log, twoTickets, record('- 1: #8', '- 2: #9').replace('draft 1', 'draft 2')]), null);
    assert.equal(await landed([record('- 1: #8', '- 2: #9'), log, twoTickets]), null);
    assert.equal(await landed([log, twoTickets, record('- 1: #8', '- 2: #9'), record('- 1: #8')]), null);
  });
});
