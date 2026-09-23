import { OWNER } from './outbox.js';
import { issueKey, prAttemptStateKey } from './cronState.js';
import { classifyGithubPrMergeability } from './issuePipeline/githubPr.js';
import { errorMessageFromUnknown } from './issuePipeline/index.js';

/**
 * The cron issue tracer: every interval, find the next `ready-for-agent` issue across the cron's
 * workspaces (in alias order, one issue per tick) and run it through `runner.startIssueRun`, the
 * same pipeline as `claude issue:…`. It skips the tick while the lock is held or agent-runner is
 * paused. Its state (last-started issue per repo, PR attempts, parked-PR notices, the last tick)
 * is in Redis, see `cronState.js`. Its own messages go to `owner`; the run's report goes there too.
 *
 * - A run counts as progress only when it pushed, opened a PR or merged. After that, the issue is
 *   not picked again in its repo, even while still open. A failed, empty or timed-out run is
 *   retried next tick.
 * - An issue with an open agent PR is worked once per PR state (head commit + base tip). While the
 *   state is unchanged the issue is parked, and the owner is told once.
 * - An issue that GitHub's native dependencies report as blocked is skipped.
 *
 * @typedef {import('./issuePipeline/githubIssue.js').OpenIssue} OpenIssue
 * @typedef {import('./issuePipeline/githubIssue.js').OpenAgentPr} OpenAgentPr
 * @typedef {import('./cronState.js').CronTickOutcome} CronTickOutcome
 */

const READY_FOR_AGENT_LABEL = 'ready-for-agent';
/** Issue run results that count as lasting progress. */
const PROGRESS = new Set(['merged', 'pr_open', 'pushed']);

/**
 * The attempt state of `pr`, given the tips of the base branches.
 * @param {OpenAgentPr} pr
 * @param {Map<string, string>} baseShaByBranch
 */
const prStateKey = (pr, baseShaByBranch) => prAttemptStateKey(pr, baseShaByBranch.get(pr.baseRefName) || '');

/** @param {OpenIssue[]} rows */
const readyForAgent = (rows) =>
  rows.filter((r) => Array.isArray(r.labels) && r.labels.some((l) => String(l).trim().toLowerCase() === READY_FOR_AGENT_LABEL));

/**
 * The lowest `ready-for-agent` issue of `repo` that isn't its last-started issue and isn't blocked
 * by an open dependency. A failed blocker lookup counts as blocked, rather than risk working on top
 * of an unresolved dependency.
 * @param {OpenIssue[]} rows
 * @param {string} repo
 * @param {Map<string, number>} lastByRepo
 * @param {(repo: string, issueNumber: number) => Promise<number>} blockedByCount
 * @returns {Promise<OpenIssue | null>}
 */
export async function pickNextRunnableIssue(rows, repo, lastByRepo, blockedByCount) {
  const last = lastByRepo.get(repo);
  const candidates = readyForAgent(rows)
    .filter((r) => r.number !== last)
    .sort((a, b) => a.number - b.number);
  for (const c of candidates) {
    const blockers = await blockedByCount(repo, c.number).catch(() => 1);
    if (!blockers) return c;
  }
  return null;
}

/**
 * Splits off issues with an open agent PR whose current state was already attempted: re-running
 * the agent on an unchanged, blocked PR only produces empty runs. Any other open-PR issue stays
 * eligible (the run resumes its branch, merges the base in on a conflict, and re-runs the gate).
 * @param {OpenIssue[]} rows
 * @param {string} repo
 * @param {Map<number, OpenAgentPr>} openPrs
 * @param {Map<string, string>} baseShaByBranch base branch → tip sha
 * @param {Map<string, string>} attempted `repo#n` → last attempted state
 * @returns {{ rows: OpenIssue[], parked: { number: number, url: string, state: string, stateKey: string }[] }}
 */
export function partitionIssuesWithOpenPr(rows, repo, openPrs, baseShaByBranch, attempted) {
  const eligible = new Set(readyForAgent(rows).map((r) => r.number));
  /** @type {{ number: number, url: string, state: string, stateKey: string }[]} */
  const parked = [];
  const kept = rows.filter((r) => {
    const pr = openPrs.get(r.number);
    if (!pr) return true;
    const stateKey = prStateKey(pr, baseShaByBranch);
    if (attempted.get(issueKey(repo, r.number)) !== stateKey) return true;
    if (eligible.has(r.number)) parked.push({ number: r.number, url: pr.url, state: classifyGithubPrMergeability(pr), stateKey });
    return false;
  });
  return { rows: kept, parked };
}

/** @param {string} s @param {number} [max] */
function truncate(s, max = 1500) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * @param {{
 *   startIssueRun: ReturnType<typeof import('./runner.js').createRunner>['startIssueRun'],
 *   lock: Pick<ReturnType<typeof import('./runLock.js').createRunLock>, 'current'>,
 *   pause: Pick<ReturnType<typeof import('./pauseFlag.js').createPauseFlag>, 'get'>,
 *   state: import('./cronState.js').CronStateStore,
 *   workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }> },
 *   github: Pick<ReturnType<typeof import('./issuePipeline/githubIssue.js').createGithubIssues>,
 *     'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha'>,
 *   outbox: Pick<ReturnType<typeof import('./outbox.js').createOutbox>, 'send'>,
 *   aliases: string[],
 *   intervalMs: number,
 *   logger?: Pick<Console, 'info' | 'warn'>,
 * }} deps
 */
export function createCronTracer({ startIssueRun, lock, pause, state, workspaces, github, outbox, aliases, intervalMs, logger = console }) {
  let inFlight = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** @param {string} text */
  const tell = (text) =>
    outbox.send({ replyTo: OWNER, text }).catch((err) => logger.warn(`cron: outbox write failed: ${errorMessageFromUnknown(err)}`));

  /** Open agent PRs of `repo`, with the tip of each base branch they target. @param {string} repo */
  async function loadOpenPrs(repo) {
    const openPrs = await github.listOpenAgentPrsByIssue(repo);
    /** @type {Map<string, string>} */
    const baseShaByBranch = new Map();
    for (const pr of openPrs.values()) {
      if (!baseShaByBranch.has(pr.baseRefName)) baseShaByBranch.set(pr.baseRefName, await github.branchHeadSha(repo, pr.baseRefName));
    }
    return { openPrs, baseShaByBranch };
  }

  /**
   * `rows` minus the issues whose open PR is parked, telling the owner once per parked state. A
   * failed lookup keeps every issue: better one empty run than a stalled cron.
   * @param {string} alias
   * @param {string} repo
   * @param {OpenIssue[]} rows
   */
  async function skipParkedPrIssues(alias, repo, rows) {
    let loaded;
    let attempted;
    let notified;
    try {
      loaded = await loadOpenPrs(repo);
      [attempted, notified] = await Promise.all([state.prAttempts(), state.parkNotices()]);
    } catch (err) {
      logger.warn(`cron: open PR lookup failed for ${repo}: ${errorMessageFromUnknown(err)}`);
      return rows;
    }
    const { rows: kept, parked } = partitionIssuesWithOpenPr(rows, repo, loaded.openPrs, loaded.baseShaByBranch, attempted);
    // forget notices for this repo's PRs that aren't parked any more (retried, merged or closed)
    const parkedNow = new Set(parked.map((p) => issueKey(repo, p.number)));
    for (const key of notified.keys()) {
      if (!key.startsWith(`${repo}#`) || parkedNow.has(key)) continue;
      await state.clearParkNotice(repo, Number(key.slice(repo.length + 1)));
    }
    for (const p of parked) {
      if (notified.get(issueKey(repo, p.number)) === p.stateKey) continue;
      const why = p.state === 'conflict' ? 'it still conflicts with the default branch' : 'the review / merge gate did not let it merge';
      await tell(
        `Cron (${alias}): parking ${repo}#${p.number}. Its PR is still open and ${why}: ${p.url}\nIt is retried when the PR branch or the default branch changes, or merge / close it yourself.`
      );
      await state.setParkNotice(repo, p.number, p.stateKey);
    }
    return kept;
  }

  /**
   * After a run, remember the state its PR (if one is open now) was left in, so an unchanged
   * blocked PR is parked instead of re-run next tick.
   * @param {string} repo
   * @param {number} issueNumber
   */
  async function recordPrState(repo, issueNumber) {
    try {
      const { openPrs, baseShaByBranch } = await loadOpenPrs(repo);
      const pr = openPrs.get(issueNumber);
      if (pr) await state.setPrAttempt(repo, issueNumber, prStateKey(pr, baseShaByBranch));
    } catch (err) {
      logger.warn(`cron: could not record the PR state of ${repo}#${issueNumber}: ${errorMessageFromUnknown(err)}`);
    }
  }

  /**
   * @param {string} alias
   * @param {string} repo
   * @param {OpenIssue} issue
   * @returns {Promise<CronTickOutcome>}
   */
  async function runIssue(alias, repo, issue) {
    const started = await startIssueRun({ issueNumber: issue.number, alias, replyTo: OWNER, trigger: 'cron' });
    if (started.refused) return { kind: started.refused };
    /** @type {CronTickOutcome} */
    const outcome = { kind: 'ran', repo, issue: issue.number, result: 'prep_failed' };
    if (!started.done) {
      await tell(`Cron (${alias}): could not start #${issue.number} in ${repo}: ${truncate(started.reply)}`);
      return outcome;
    }
    try {
      const result = await started.done;
      if (result && PROGRESS.has(result)) {
        await state.setLastStarted(repo, issue.number);
        outcome.result = 'progress';
      } else {
        // failed, timeout and no_changes stay distinct in the tick state; none of them is progress
        outcome.result = result || 'no_progress';
        if (!result) outcome.note = 'no result';
        // a failed or timed-out run has already reported to owner, but an empty one is silent
        if (result === 'no_changes') {
          await tell(`Cron (${alias}): ${repo}#${issue.number} made no changes, so it doesn't count as progress. The next tick retries it.`);
        }
      }
    } catch (err) {
      const e = errorMessageFromUnknown(err);
      outcome.result = 'failed';
      outcome.note = truncate(e, 200);
      await tell(`Cron (${alias}): the run for ${repo}#${issue.number} failed: ${truncate(e)}`);
    } finally {
      await recordPrState(repo, issue.number);
    }
    return outcome;
  }

  /**
   * One cron evaluation: skip while busy or paused, else run the first runnable issue found.
   * @returns {Promise<CronTickOutcome>}
   */
  async function tick() {
    let phase = 'checking the lock';
    try {
      if (await pause.get()) return { kind: 'paused' };
      if (await lock.current()) return { kind: 'busy' };
      phase = 'reading cron state';
      const lastByRepo = await state.lastStarted();
      for (const alias of aliases) {
        let repo;
        try {
          const ws = await workspaces.resolveIssueWorkspace(alias);
          repo = await github.resolveIssueRepo(ws.root, alias);
        } catch (err) {
          logger.warn(`cron: skipping workspace "${alias}": ${errorMessageFromUnknown(err)}`);
          continue;
        }
        phase = `listing open issues (${alias})`;
        const rows = await skipParkedPrIssues(alias, repo, await github.listOpenIssues(repo));
        phase = `checking issue dependencies (${alias})`;
        const next = await pickNextRunnableIssue(rows, repo, lastByRepo, github.blockedByCount);
        if (!next) continue;
        phase = `running ${repo}#${next.number}`;
        return await runIssue(alias, repo, next);
      }
      return { kind: 'no_eligible' };
    } catch (err) {
      const e = errorMessageFromUnknown(err);
      logger.warn(`cron: tick failed while ${phase}: ${e}`);
      await tell(`Cron tick failed while ${phase}: ${truncate(e)}`);
      return { kind: 'error', note: `${phase}: ${truncate(e, 200)}` };
    }
  }

  /**
   * A tick plus its record in Redis. Returns null (and does nothing) while a tick is in flight:
   * a tick lasts as long as the run it starts.
   * @returns {Promise<CronTickOutcome | null>}
   */
  async function runOnce() {
    if (inFlight) return null;
    inFlight = true;
    const startedAt = Date.now();
    try {
      const outcome = await tick();
      await state.writeTick({ outcome, intervalMs, startedAt }).catch((err) => logger.warn(`cron: could not save the tick: ${errorMessageFromUnknown(err)}`));
      return outcome;
    } finally {
      inFlight = false;
    }
  }

  return {
    tick,
    runOnce,

    /** Tick now, then every `intervalMs`. */
    async start() {
      if (timer) return;
      await state.writeStarted({ intervalMs }).catch((err) => logger.warn(`cron: could not save its state: ${errorMessageFromUnknown(err)}`));
      timer = setInterval(() => void runOnce(), intervalMs);
      logger.info(`agent-runner: cron issue tracer every ${Math.round(intervalMs / 1000)}s over ${aliases.join(', ') || '(no workspaces)'}`);
      void runOnce();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
