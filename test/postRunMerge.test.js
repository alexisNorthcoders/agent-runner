import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createGithubPr,
  githubPrMergeErrorLooksStaleHead,
  githubPrMergeErrorLooksNoAutoMergeGate,
  githubPrMergeErrorLooksNotYetMergeable,
  githubErrorLooksTransientNetwork,
  githubPrUpdateBranchErrorLooksNoOp,
  pickGithubMergeStrategy,
  githubMergeMethodSummaryLabel,
  classifyGithubPrMergeability,
} from '../src/issuePipeline/githubPr.js';
import { loadPipelineSettings } from '../src/issuePipeline/settings.js';
import { callbackExec } from './helpers/fakeExec.js';

/** @type {(cmd: string, args: string[], opts: object, cb: Function) => void} */
let handler = () => {
  throw new Error('no gh handler set');
};

/** Fast mergeability polls (real sleeps would make the suite slow), and a fake `gh`. */
const prs = () =>
  createGithubPr({
    exec: callbackExec(() => handler),
    settings: loadPipelineSettings({ CLAUDE_POST_RUN_MERGEABLE_POLL_MS: '0', CLAUDE_POST_RUN_MERGEABLE_MAX_WAIT_MS: '2000' }),
  });

/** Kept from the original tests, where it wrapped the env tuning now done in `prs()`. */
const withFastMergeablePoll = (fn) => fn;

function replyMergeableReady(_cmd, args, _opts, cb) {
  if (args[0] === 'pr' && args[1] === 'view') {
    cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state: 'OPEN' }), '');
    return true;
  }
  return false;
}

describe('PR merge / update-branch error heuristics', () => {
  it('detects stale-head auto-merge errors', () => {
    assert.equal(
      githubPrMergeErrorLooksStaleHead(
        'Head branch is out of date. Review and try the merge again.'
      ),
      true
    );
    assert.equal(
      githubPrMergeErrorLooksStaleHead(
        'Message: Base branch was modified. Review and try the merge again., Locations: [{Line:1 Column:58}]'
      ),
      true
    );
    assert.equal(githubPrMergeErrorLooksStaleHead('unrelated failure'), false);
  });

  it('detects not-yet-mergeable errors (post-push race)', () => {
    assert.equal(
      githubPrMergeErrorLooksNotYetMergeable(
        'Message: Pull Request is not mergeable, Locations: [{Line:1 Column:58}]'
      ),
      true
    );
    assert.equal(githubPrMergeErrorLooksNotYetMergeable('Base branch was modified'), false);
  });

  it('detects transient network errors from gh', () => {
    assert.equal(
      githubErrorLooksTransientNetwork(
        'Post "https://api.github.com/graphql": dial tcp 20.26.156.210:443: i/o timeout'
      ),
      true
    );
    assert.equal(githubErrorLooksTransientNetwork('read: connection reset by peer'), true);
    assert.equal(githubErrorLooksTransientNetwork('Pull Request is not mergeable'), false);
  });

  it('detects no-auto-merge-gate errors (unprotected main / clean status)', () => {
    assert.equal(
      githubPrMergeErrorLooksNoAutoMergeGate(
        'Message: Pull request Protected branch rules not configured for this branch, Locations: [{Line:1 Column:72}]\n'
      ),
      true
    );
    assert.equal(
      githubPrMergeErrorLooksNoAutoMergeGate('Pull request is in clean status'),
      true
    );
    assert.equal(githubPrMergeErrorLooksNoAutoMergeGate('Head branch is out of date'), false);
  });

  it('treats GitHub update-branch 422 no-op as retryable', () => {
    const msg =
      '{"message":"There are no new commits on the base branch.","status":"422"}gh: There are no new commits on the base branch. (HTTP 422)';
    assert.equal(githubPrUpdateBranchErrorLooksNoOp(msg), true);
    assert.equal(githubPrUpdateBranchErrorLooksNoOp('merge conflict on update-branch'), false);
  });

  it('pickGithubMergeStrategy prefers squash, then merge, then rebase', () => {
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: true,
        allow_merge_commit: true,
        allow_rebase_merge: true,
      }),
      'squash'
    );
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: false,
        allow_merge_commit: true,
        allow_rebase_merge: true,
      }),
      'merge'
    );
    assert.equal(
      pickGithubMergeStrategy({
        allow_squash_merge: false,
        allow_merge_commit: false,
        allow_rebase_merge: true,
      }),
      'rebase'
    );
    assert.equal(pickGithubMergeStrategy({}), null);
  });

  it('githubMergeMethodSummaryLabel matches the report wording', () => {
    assert.equal(githubMergeMethodSummaryLabel('squash'), 'squash');
    assert.equal(githubMergeMethodSummaryLabel('merge'), 'merge commit');
    assert.equal(githubMergeMethodSummaryLabel('rebase'), 'rebase');
  });

  it('classifyGithubPrMergeability covers ready / waiting / conflict / behind', () => {
    assert.equal(
      classifyGithubPrMergeability({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        state: 'OPEN',
      }),
      'ready'
    );
    assert.equal(
      classifyGithubPrMergeability({
        mergeable: 'UNKNOWN',
        mergeStateStatus: 'UNKNOWN',
        state: 'OPEN',
      }),
      'waiting'
    );
    assert.equal(
      classifyGithubPrMergeability({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'BEHIND',
        state: 'OPEN',
      }),
      'behind'
    );
    assert.equal(
      classifyGithubPrMergeability({
        mergeable: 'CONFLICTING',
        mergeStateStatus: 'DIRTY',
        state: 'OPEN',
      }),
      'conflict'
    );
    assert.equal(
      classifyGithubPrMergeability({
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        state: 'MERGED',
      }),
      'closed'
    );
  });
});

describe('tryGhRepoMergeCapabilities (mocked gh)', () => {
  afterEach(() => {
    handler = () => {};
  });

  it('rejects non-JSON stdout with a clear error', async () => {
    handler = (cmd, args, opts, cb) => {
      assert.equal(cmd, 'gh');
      cb(null, 'NOTICE: extra noise\nnot-json', '');
    };
    const r = await prs().repoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not parse gh api --jq JSON/);
  });

  it('rejects jq output missing a required key', async () => {
    handler = (_cmd, _args, _opts, cb) => {
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: true,
          allow_merge_commit: true,
          allow_rebase_merge: true,
        }),
        ''
      );
    };
    const r = await prs().repoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /missing "allow_auto_merge"/);
  });

  it('rejects non-boolean allow_auto_merge (e.g. JSON null)', async () => {
    handler = (_cmd, _args, _opts, cb) => {
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: false,
          allow_merge_commit: true,
          allow_rebase_merge: true,
          allow_auto_merge: null,
        }),
        ''
      );
    };
    const r = await prs().repoMergeCapabilities('/repo', 'o', 'r');
    assert.equal(r.ok, false);
    assert.match(r.error, /non-boolean allow_auto_merge/);
  });

  it('accepts exact GitHub REST-style boolean shape', async () => {
    handler = (cmd, args, opts, cb) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(args.slice(0, 3), ['api', 'repos/acme/widget', '--jq']);
      cb(
        null,
        JSON.stringify({
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
          allow_auto_merge: true,
        }),
        ''
      );
    };
    const r = await prs().repoMergeCapabilities('/repo', 'acme', 'widget');
    assert.equal(r.ok, true);
    assert.deepEqual(r, {
      ok: true,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_auto_merge: true,
    });
  });
});

describe('tryGhPrQueueAutoMerge (mocked gh, issue #47)', () => {
  afterEach(() => {
    handler = () => {};
  });

  it('falls back to merge commit when squash is disabled but merge + auto-merge are allowed', async () => {
    /** @type {{ cmd: string, args: string[] }[]} */
    const calls = [];
    handler = (cmd, args, opts, cb) => {
      calls.push({ cmd, args: [...args] });
      const sub = args[0];
      if (sub === 'api' && String(args[1] || '').startsWith('repos/')) {
        cb(
          null,
          JSON.stringify({
            allow_squash_merge: false,
            allow_merge_commit: true,
            allow_rebase_merge: true,
            allow_auto_merge: true,
          }),
          ''
        );
        return;
      }
      if (sub === 'pr' && args[1] === 'merge') {
        assert.ok(args.includes('--auto'));
        assert.ok(args.includes('--merge'));
        assert.ok(!args.includes('--squash'));
        cb(null, '', '');
        return;
      }
      cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
    };

    const r = await prs().queueAutoMerge('/tmp/r', 'https://github.com/o/r/pull/47');
    assert.equal(r.ok, true);
    assert.equal(r.mergeMethod, 'merge');
    assert.equal(calls.length, 2);
    assert.match(calls[0].args[1], /^repos\/o\/r$/);
    assert.equal(calls[1].args[0], 'pr');
  });

  it(
    'falls back to direct merge when allow_auto_merge is false (e.g. private Free-plan repo)',
    withFastMergeablePoll(async () => {
      /** @type {{ cmd: string, args: string[] }[]} */
      const calls = [];
      handler = (cmd, args, _opts, cb) => {
        calls.push({ cmd, args: [...args] });
        if (replyMergeableReady(cmd, args, _opts, cb)) return;
        if (args[0] === 'api') {
          cb(
            null,
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: true,
              allow_rebase_merge: true,
              allow_auto_merge: false,
            }),
            ''
          );
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          assert.ok(!args.includes('--auto'), 'must not call --auto when repo disallows it');
          assert.ok(args.includes('--squash'));
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };
      const r = await prs().queueAutoMerge('/tmp/r', 'https://github.com/o/rr/pull/2');
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(r.mergeMethod, 'squash');
      const mergeCalls = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
      assert.equal(mergeCalls.length, 1);
      assert.ok(!mergeCalls[0].args.includes('--auto'));
      const viewCalls = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'view');
      assert.ok(viewCalls.length >= 1, 'should poll mergeability before direct merge');
    })
  );

  it(
    'retries direct merge after update-branch when base was modified (private repo path)',
    withFastMergeablePoll(async () => {
      /** @type {{ cmd: string, args: string[] }[]} */
      const calls = [];
      let mergeAttempts = 0;
      handler = (cmd, args, _opts, cb) => {
        calls.push({ cmd, args: [...args] });
        if (replyMergeableReady(cmd, args, _opts, cb)) return;
        if (args[0] === 'api' && String(args[1] || '').startsWith('repos/') && !args.includes('-X')) {
          cb(
            null,
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: true,
              allow_rebase_merge: true,
              allow_auto_merge: false,
            }),
            ''
          );
          return;
        }
        if (args[0] === 'api' && args.includes('-X') && args.includes('PUT')) {
          assert.match(String(args[args.length - 1] || args[3] || ''), /update-branch/);
          cb(null, '', '');
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeAttempts += 1;
          assert.ok(!args.includes('--auto'));
          if (mergeAttempts === 1) {
            const err = /** @type {any} */ (new Error('gh failed'));
            err.stderr =
              'Message: Base branch was modified. Review and try the merge again., Locations: [{Line:1 Column:58}]';
            cb(err, '', err.stderr);
            return;
          }
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge(
        '/tmp/r',
        'https://github.com/alexisNorthcoders/chess-trainer/pull/12'
      );
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(r.staleHeadSynced, true);
      assert.equal(mergeAttempts, 2);
      const updateCalls = calls.filter(
        (c) => c.args[0] === 'api' && c.args.includes('PUT')
      );
      assert.equal(updateCalls.length, 1);
    })
  );

  it(
    'waits through UNKNOWN mergeability then merges (post-push race like PR #45)',
    withFastMergeablePoll(async () => {
      let viewPolls = 0;
      let mergeAttempts = 0;
      handler = (cmd, args, _opts, cb) => {
        if (args[0] === 'api' && !args.includes('-X')) {
          cb(
            null,
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: true,
              allow_rebase_merge: true,
              allow_auto_merge: false,
            }),
            ''
          );
          return;
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          viewPolls += 1;
          if (viewPolls < 3) {
            cb(
              null,
              JSON.stringify({
                mergeable: 'UNKNOWN',
                mergeStateStatus: 'UNKNOWN',
                state: 'OPEN',
              }),
              ''
            );
            return;
          }
          cb(
            null,
            JSON.stringify({
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              state: 'OPEN',
            }),
            ''
          );
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeAttempts += 1;
          assert.ok(!args.includes('--auto'));
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge(
        '/tmp/r',
        'https://github.com/alexisNorthcoders/chess-trainer/pull/45'
      );
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.ok(viewPolls >= 3);
      assert.equal(mergeAttempts, 1);
    })
  );

  it(
    'retries after transient not-mergeable error once mergeability is ready',
    withFastMergeablePoll(async () => {
      let mergeAttempts = 0;
      handler = (cmd, args, _opts, cb) => {
        if (replyMergeableReady(cmd, args, _opts, cb)) return;
        if (args[0] === 'api' && !args.includes('-X')) {
          cb(
            null,
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: true,
              allow_rebase_merge: true,
              allow_auto_merge: false,
            }),
            ''
          );
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeAttempts += 1;
          if (mergeAttempts === 1) {
            const err = /** @type {any} */ (new Error('gh failed'));
            err.stderr =
              'Message: Pull Request is not mergeable, Locations: [{Line:1 Column:58}]';
            cb(err, '', err.stderr);
            return;
          }
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge(
        '/tmp/r',
        'https://github.com/alexisNorthcoders/chess-trainer/pull/45'
      );
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(mergeAttempts, 2);
    })
  );

  it(
    'retries direct merge after a network timeout (issue #8 PR left open)',
    withFastMergeablePoll(async () => {
      let mergeAttempts = 0;
      handler = (cmd, args, _opts, cb) => {
        if (replyMergeableReady(cmd, args, _opts, cb)) return;
        if (args[0] === 'api' && !args.includes('-X')) {
          cb(null, JSON.stringify({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: false }), '');
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeAttempts += 1;
          if (mergeAttempts === 1) {
            const err = /** @type {any} */ (new Error('gh failed'));
            err.stderr = 'Post "https://api.github.com/graphql": dial tcp 20.26.156.210:443: i/o timeout';
            cb(err, '', err.stderr);
            return;
          }
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge('/tmp/r', 'https://github.com/alexisNorthcoders/home-manuals/pull/10');
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(mergeAttempts, 2);
    })
  );

  it(
    'treats a timed-out merge that landed on GitHub anyway as merged',
    withFastMergeablePoll(async () => {
      let mergeAttempts = 0;
      handler = (cmd, args, _opts, cb) => {
        if (args[0] === 'api' && !args.includes('-X')) {
          cb(null, JSON.stringify({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, allow_auto_merge: false }), '');
          return;
        }
        if (args[0] === 'pr' && args[1] === 'view') {
          const state = mergeAttempts === 0 ? 'OPEN' : 'MERGED';
          cb(null, JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', state }), '');
          return;
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          mergeAttempts += 1;
          const err = /** @type {any} */ (new Error('gh failed'));
          err.stderr = 'Post "https://api.github.com/graphql": dial tcp 20.26.156.210:443: i/o timeout';
          cb(err, '', err.stderr);
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge('/tmp/r', 'https://github.com/alexisNorthcoders/home-manuals/pull/10');
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(mergeAttempts, 1);
    })
  );

  it(
    'falls back to direct merge when --auto fails with unprotected-branch gate error',
    withFastMergeablePoll(async () => {
      /** @type {{ cmd: string, args: string[] }[]} */
      const calls = [];
      handler = (cmd, args, opts, cb) => {
        calls.push({ cmd, args: [...args] });
        if (replyMergeableReady(cmd, args, opts, cb)) return;
        const sub = args[0];
        if (sub === 'api' && String(args[1] || '').startsWith('repos/')) {
          cb(
            null,
            JSON.stringify({
              allow_squash_merge: true,
              allow_merge_commit: true,
              allow_rebase_merge: true,
              allow_auto_merge: true,
            }),
            ''
          );
          return;
        }
        if (sub === 'pr' && args[1] === 'merge') {
          if (args.includes('--auto')) {
            const err = /** @type {any} */ (new Error('gh failed'));
            err.stderr =
              'Message: Pull request Protected branch rules not configured for this branch, Locations: [{Line:1 Column:72}]\n';
            cb(err, '', err.stderr);
            return;
          }
          assert.ok(args.includes('--squash'));
          assert.ok(!args.includes('--auto'));
          cb(null, '', '');
          return;
        }
        cb(new Error(`unexpected exec: ${cmd} ${args.join(' ')}`));
      };

      const r = await prs().queueAutoMerge(
        '/tmp/r',
        'https://github.com/alexisNorthcoders/WhatsappBot/pull/72'
      );
      assert.equal(r.ok, true);
      assert.equal(r.mergedDirectly, true);
      assert.equal(r.mergeMethod, 'squash');
      const mergeCalls = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'merge');
      assert.equal(mergeCalls.length, 2);
      assert.ok(mergeCalls[0].args.includes('--auto'));
      assert.ok(!mergeCalls[1].args.includes('--auto'));
    })
  );
});

describe('queueAutoMerge: merge-settings read on a network error (issue #5)', () => {
  const PR = 'https://github.com/acme/widget/pull/17';
  const CAPS = JSON.stringify({ allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, allow_auto_merge: true });
  const isCapsRead = (args) => args[0] === 'api' && String(args[1] || '').startsWith('repos/') && !args.includes('-X');
  /** @param {string} stderr @returns {any} */
  const ghError = (stderr) => Object.assign(new Error('gh failed'), { stderr });
  const TIMEOUT = 'Get "https://api.github.com/repos/acme/widget": dial tcp 20.26.156.210:443: i/o timeout';

  /** @param {(attempt: number) => any} capsError a `gh` error for this 1-based read, or null to answer */
  function setup(capsError) {
    /** @type {number[]} */
    const sleeps = [];
    let capsReads = 0;
    let merges = 0;
    const exec = callbackExec(() => (_cmd, args, _opts, cb) => {
      if (isCapsRead(args)) {
        const err = capsError(++capsReads);
        return err ? cb(err, '', err.stderr) : cb(null, CAPS, '');
      }
      if (args[0] === 'pr' && args[1] === 'merge') {
        merges++;
        return cb(null, '', '');
      }
      cb(new Error(`unexpected exec: ${args.join(' ')}`));
    });
    const prs = createGithubPr({
      exec,
      settings: loadPipelineSettings({ CLAUDE_POST_RUN_MERGEABLE_POLL_MS: '0' }),
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { prs, sleeps, counts: () => ({ capsReads, merges }) };
  }

  it('waits and retries once after an i/o timeout, then merges with no error', async () => {
    const { prs, sleeps, counts } = setup((n) => (n === 1 ? ghError(TIMEOUT) : null));
    const r = await prs.queueAutoMerge('/repo', PR);
    assert.equal(r.ok, true);
    assert.equal(r.error, undefined);
    assert.deepEqual(counts(), { capsReads: 2, merges: 1 });
    assert.equal(sleeps.length, 1);
  });

  it('gives up after a second network error, and says it retried', async () => {
    const { prs, sleeps, counts } = setup(() => ghError('read tcp: connection reset by peer'));
    const r = await prs.queueAutoMerge('/repo', PR);
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not read repository merge settings/);
    assert.match(r.error, /retried/);
    assert.deepEqual(counts(), { capsReads: 2, merges: 0 });
    assert.equal(sleeps.length, 1);
  });

  for (const stderr of [
    'dial tcp: lookup api.github.com: Temporary failure in name resolution (EAI_AGAIN)',
    'HTTP 502: 502 Bad Gateway (https://api.github.com/repos/acme/widget)',
    'HTTP 503: 503 Service Unavailable (https://api.github.com/repos/acme/widget)',
    'HTTP 504: 504 Gateway Timeout (https://api.github.com/repos/acme/widget)',
  ]) {
    it(`retries once after a network error: ${stderr.slice(0, 40)}…`, async () => {
      const { prs, sleeps, counts } = setup((n) => (n === 1 ? ghError(stderr) : null));
      const r = await prs.queueAutoMerge('/repo', PR);
      assert.equal(r.ok, true);
      assert.deepEqual(counts(), { capsReads: 2, merges: 1 });
      assert.equal(sleeps.length, 1);
    });
  }

  it('does not retry a permanent error such as bad auth', async () => {
    const { prs, sleeps, counts } = setup(() => ghError('HTTP 401: Bad credentials (https://api.github.com/repos/acme/widget)'));
    const r = await prs.queueAutoMerge('/repo', PR);
    assert.equal(r.ok, false);
    assert.match(r.error, /Could not read repository merge settings \(GitHub API\): HTTP 401: Bad credentials/);
    assert.doesNotMatch(r.error, /retried/);
    assert.deepEqual(counts(), { capsReads: 1, merges: 0 });
    assert.equal(sleeps.length, 0);
  });
});
