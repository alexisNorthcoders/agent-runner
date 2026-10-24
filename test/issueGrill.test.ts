import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GRILL_LOG_MARKER, createIssueGrillLookups, pickGrillCandidate, runIssueGrill } from '../src/issueGrill.ts';
import { REPO_INSIGHT_PRIORITY } from '../src/repoInsight.ts';
import type { GrillCandidate } from '../src/issueGrill.ts';
import type { TriageSuggestion } from '../src/issuePipeline/githubIssue.ts';

const cand = (o: Partial<GrillCandidate>): GrillCandidate => ({ alias: 'bot', repo: 'me/bot', number: 1, title: 't', url: 'u', createdAt: '2026-01-01T00:00:00Z', ...o });
const issue = (o: Partial<TriageSuggestion>): TriageSuggestion => ({ number: 1, title: 'T', url: 'https://x/1', createdAt: '2026-01-01T00:00:00Z', comments: [], ...o });

describe('pickGrillCandidate', () => {
  it('is null without candidates', () => {
    assert.equal(pickGrillCandidate([]), null);
  });

  it('takes the oldest issue', () => {
    const picked = pickGrillCandidate([cand({ number: 1, createdAt: '2026-03-01T00:00:00Z' }), cand({ number: 2, createdAt: '2026-02-01T00:00:00Z' })]);
    assert.equal(picked?.number, 2);
  });

  it('breaks a tie by priority order, then issue number', () => {
    const at = '2026-02-01T00:00:00Z';
    assert.equal(pickGrillCandidate([cand({ alias: 'go-server', number: 1, createdAt: at }), cand({ alias: 'bot', number: 9, createdAt: at })])?.alias, 'bot');
    assert.equal(pickGrillCandidate([cand({ number: 8, createdAt: at }), cand({ number: 3, createdAt: at })])?.number, 3);
  });
});

describe('runIssueGrill', () => {
  type Fixture = { issues?: Record<string, TriageSuggestion[]>; broken?: Record<string, string>; commentsAfterRun?: string[]; sessionText?: string; aliasRepo?: Record<string, string> };
  const setup = ({ issues = {}, broken = {}, commentsAfterRun = [`${GRILL_LOG_MARKER} (2 rounds)\n...`], sessionText = 'done', aliasRepo = {} }: Fixture) => {
    const launched: { cwd: string; prompt: string }[] = [];
    const deps = {
      lookups: createIssueGrillLookups({
        workspaces: {
          resolveIssueWorkspace: async (alias) => {
            if (!alias) throw new Error('no alias');
            if (broken[alias]) throw new Error(broken[alias]);
            return { alias, root: `/ws/${alias}` };
          },
        },
        github: {
          resolveIssueRepo: async (_root, alias) => aliasRepo[alias ?? ''] ?? `me/${alias}`,
          listTriageSuggestions: async (repo) => issues[repo] ?? [],
          issueCommentBodies: async () => (launched.length ? commentsAfterRun : []),
        },
      }),
      resolveWorkspace: async (alias: string) => ({ root: `/ws/${alias}` }),
      launchSession: async (p: { cwd: string; prompt: string }) => (launched.push(p), { text: sessionText }),
    };
    return { deps, launched };
  };

  it('grills the oldest issue across aliases in its own workspace and reports it', async () => {
    const { deps, launched } = setup({
      issues: {
        'me/bot': [issue({ number: 4, title: 'Newer', createdAt: '2026-03-01T00:00:00Z' })],
        'me/go-server': [issue({ number: 7, title: 'Older', url: 'https://x/7', createdAt: '2026-02-01T00:00:00Z' })],
      },
      sessionText: 'working\nhttps://x/7 and 2 LOW-CONFIDENCE\n\n',
    });
    const line = await runIssueGrill(deps);
    assert.deepEqual(launched, [{ cwd: '/ws/go-server', prompt: '/self-grill 7' }]);
    assert.equal(line, 'issue-grill: go-server #7 "Older" → https://x/7 and 2 LOW-CONFIDENCE (https://x/7)');
  });

  it('skips issues that already have a decision log, even with leading whitespace', async () => {
    const { deps, launched } = setup({
      issues: {
        'me/bot': [
          issue({ number: 1, createdAt: '2026-01-01T00:00:00Z', comments: ['hi', `  \n${GRILL_LOG_MARKER} (3 rounds)`] }),
          issue({ number: 2, createdAt: '2026-01-02T00:00:00Z', comments: [`not a ${GRILL_LOG_MARKER}`] }),
        ],
      },
    });
    await runIssueGrill(deps);
    assert.equal(launched[0].prompt, '/self-grill 2');
  });

  it('lists an issue once when two aliases resolve to the same repo', async () => {
    const { deps } = setup({ issues: { 'me/shared': [issue({ number: 5 })] }, aliasRepo: { bot: 'me/shared', 'chess-trainer': 'me/shared' } });
    const { candidates } = await deps.lookups.candidates();
    assert.deepEqual(candidates.map((c) => [c.alias, c.number]), [['bot', 5]]);
  });

  it('still picks from the other aliases when one fails', async () => {
    const { deps, launched } = setup({ broken: { bot: 'no such workspace' }, issues: { 'me/go-server': [issue({ number: 3 })] } });
    await runIssueGrill(deps);
    assert.equal(launched[0].cwd, '/ws/go-server');
  });

  it('says so, with the failures, when there is nothing to grill', async () => {
    const quiet = setup({});
    assert.equal(await runIssueGrill(quiet.deps), 'issue-grill: nothing to grill');
    assert.equal(quiet.launched.length, 0);
    const noisy = setup({ broken: { bot: 'a boom', 'go-server': 'gh down' } });
    assert.equal(await runIssueGrill(noisy.deps), 'issue-grill: nothing to grill (failed: bot: a boom; go-server: gh down)');
  });

  it('throws when every alias failed', async () => {
    const broken = Object.fromEntries(REPO_INSIGHT_PRIORITY.map((a) => [a, 'down']));
    const { deps, launched } = setup({ broken });
    await assert.rejects(runIssueGrill(deps), /every workspace failed.*bot: down/);
    assert.equal(launched.length, 0);
  });

  it('throws with the last line of the session text when no decision log appeared', async () => {
    const long = 'x'.repeat(400);
    const { deps } = setup({ issues: { 'me/bot': [issue({ number: 6 })] }, commentsAfterRun: ['unrelated'], sessionText: `first\n  ${long}  \n` });
    await assert.rejects(runIssueGrill(deps), (err: Error) => {
      assert.ok(err.message.startsWith('issue-grill: bot #6 finished without a decision log: xxx'));
      assert.equal(err.message.endsWith('x'.repeat(300)), true);
      assert.equal(err.message.length, 'issue-grill: bot #6 finished without a decision log: '.length + 300);
      return true;
    });
  });
});
