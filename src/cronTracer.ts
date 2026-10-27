/**
 * The cron issue tracer: every interval, find the next `ready-for-agent` issue across the cron's
 * workspaces (in alias order, one issue per tick) and run it through `runner.startIssueRun`, the
 * same pipeline as `claude issue:…`. It skips the tick while the lock is held or agent-runner is
 * paused. Its state (last-started issue per repo, PR attempts, parked-PR notices, the last tick)
 * is in Redis, see `cronState.ts`. Its own messages go to `owner`; the run's report goes there too.
 *
 * - A run counts as progress only when it pushed, opened a PR or merged. After that, the issue is
 *   not picked again in its repo, even while still open. A failed, empty or timed-out run is
 *   retried next tick.
 * - An issue with an open agent PR is worked once per PR state (head commit + base tip). While the
 *   state is unchanged the issue is parked, and the owner is told once, unless the run that left
 *   it there made progress: its own message (`✅ PR open`, `⚠️ merge blocked`) already said so.
 *   The exception is a PR that passed review but whose merge failed only on a network error: no
 *   attempt is recorded, and it is not progress, so the next tick works it again and post-run
 *   retries the merge. A run the usage
 *   limit cut short (result `limited`) records no attempt either, so the issue is worked again
 *   after the reset.
 * - An issue whose last NO_CHANGES_LIMIT runs all made no changes is parked (skipped), and the
 *   owner is told once; it likely needs no code. Lasting progress resets the count.
 * - An issue that GitHub's native dependencies report as blocked is skipped.
 * - The usage-limit pause (an agent hit its usage limit) skips the tick until it resets.
 * - The owner's general pause skips the tick; a workspace they paused by hand is skipped, and the
 *   tick moves on to the next one.
 * - Each tick first deletes stale active-run files (owner and agent both gone), so status doesn't
 *   show a dead run forever.
 */

import { OWNER } from './outbox.ts';
import { issueKey, prAttemptStateKey } from './cronState.ts';
import { classifyGithubPrMergeability } from './issuePipeline/githubPr.ts';
import { errorText } from './narrow.ts';
import type { OpenIssue, OpenAgentPr, createGithubIssues } from './issuePipeline/githubIssue.ts';
import type { CronStateStore } from './cronState.ts';
import type { createRunner } from './runner.ts';
import type { createRunLock } from './runLock.ts';
import type { createPauseFlag } from './pauseFlag.ts';
import type { createManualPause } from './manualPause.ts';
import type { createUsageLimitPause } from './usageLimitPause.ts';
import type { createOutbox } from './outbox.ts';
import type { CronTickOutcome } from './officeWire.ts';

const READY_FOR_AGENT_LABEL = 'ready-for-agent';
/** Issue run results that count as lasting progress. */
const PROGRESS = new Set(['merged', 'pr_open', 'pushed']);
/** Consecutive `no_changes` runs after which the cron sets an issue aside (e.g. work done outside the repo). */
export const NO_CHANGES_LIMIT = 3;

/**
 * The attempt state of `pr`, given the tips of the base branches.
 */
const prStateKey = (pr: OpenAgentPr, baseShaByBranch: Map<string, string>) => prAttemptStateKey(pr, baseShaByBranch.get(pr.baseRefName) || '');

/**
 * Whether `row` carries `label`, ignoring case and whitespace.
 */
export const hasLabel = (row: OpenIssue, label: string) => Array.isArray(row.labels) && row.labels.some((l) => String(l).trim().toLowerCase() === label);

export const readyForAgent = (rows: OpenIssue[]) => rows.filter((r) => hasLabel(r, READY_FOR_AGENT_LABEL));

/**
 * Whether GitHub's native dependencies say an issue is blocked by an open issue. A failed lookup
 * counts as blocked, rather than risk working on top of an unresolved dependency.
 */
export const isBlocked = async (blockedByCount: (repo: string, issueNumber: number) => Promise<number>, repo: string, issueNumber: number) => (await blockedByCount(repo, issueNumber).catch(() => 1)) > 0;

/**
 * Open agent PRs of `repo`, with the tip of each base branch they target.
 */
export async function loadOpenAgentPrs(github: Pick<ReturnType<typeof createGithubIssues>, 'listOpenAgentPrsByIssue' | 'branchHeadSha'>, repo: string) {
  const openPrs = await github.listOpenAgentPrsByIssue(repo);
  const baseShaByBranch: Map<string, string> = new Map();
  for (const pr of openPrs.values()) {
    if (!baseShaByBranch.has(pr.baseRefName)) baseShaByBranch.set(pr.baseRefName, await github.branchHeadSha(repo, pr.baseRefName));
  }
  return { openPrs, baseShaByBranch };
}

/**
 * The lowest `ready-for-agent` issue of `repo` that isn't its last-started issue and isn't blocked
 * by an open dependency (`isBlocked`).
 */
export async function pickNextRunnableIssue(rows: OpenIssue[], repo: string, lastByRepo: Map<string, number>, blockedByCount: (repo: string, issueNumber: number) => Promise<number>): Promise<OpenIssue | null> {
  const last = lastByRepo.get(repo);
  const candidates = readyForAgent(rows)
    .filter((r) => r.number !== last)
    .sort((a, b) => a.number - b.number);
  for (const c of candidates) {
    if (!(await isBlocked(blockedByCount, repo, c.number))) return c;
  }
  return null;
}

/**
 * Splits off issues with an open agent PR whose current state was already attempted: re-running
 * the agent on an unchanged, blocked PR only produces empty runs. Any other open-PR issue stays
 * eligible (the run resumes its branch, merges the base in on a conflict, and re-runs the gate).
 * @param baseShaByBranch base branch → tip sha
 * @param attempted `repo#n` → last attempted state
 */
export function partitionIssuesWithOpenPr(rows: OpenIssue[], repo: string, openPrs: Map<number, OpenAgentPr>, baseShaByBranch: Map<string, string>, attempted: Map<string, string>): { rows: OpenIssue[]; parked: { number: number; url: string; state: string; stateKey: string }[] } {
  const eligible = new Set(readyForAgent(rows).map((r) => r.number));
  const parked: { number: number; url: string; state: string; stateKey: string }[] = [];
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

/**
 * A repo's `ready-for-agent` issues as the cron sees them: **parked** (open agent PR whose state
 * was already attempted), **blocked** (open native dependency, or a failed lookup), else
 * **runnable**. Each list is in ascending issue number.
 * @param rows the repo's open issues
 * @param attempted `repo#n` → last attempted state (`cronState.prAttempts`)
 */
export async function classifyReadyIssues(github: Pick<ReturnType<typeof createGithubIssues>, 'listOpenAgentPrsByIssue' | 'branchHeadSha' | 'blockedByCount'>, repo: string, rows: OpenIssue[], attempted: Map<string, string>) {
  const { openPrs, baseShaByBranch } = await loadOpenAgentPrs(github, repo);
  const { rows: kept, parked } = partitionIssuesWithOpenPr(rows, repo, openPrs, baseShaByBranch, attempted);
  const runnable: OpenIssue[] = [];
  const blocked: OpenIssue[] = [];
  for (const r of readyForAgent(kept).sort((a, b) => a.number - b.number)) {
    ((await isBlocked(github.blockedByCount, repo, r.number)) ? blocked : runnable).push(r);
  }
  return { runnable, blocked, parked: parked.sort((a, b) => a.number - b.number) };
}

function truncate(s: string, max = 1500) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function createCronTracer({ startIssueRun, lock, pause, manualPause, usageLimit, sweepStale = async () => {}, state, workspaces, github, outbox, aliases, intervalMs, logger = console }: {
    startIssueRun: ReturnType<typeof createRunner>['startIssueRun'];
    lock: Pick<ReturnType<typeof createRunLock>, 'current'>;
    pause: Pick<ReturnType<typeof createPauseFlag>, 'get'>;
    manualPause: Pick<ReturnType<typeof createManualPause>, 'general' | 'forWorkspace'>;
    usageLimit: Pick<ReturnType<typeof createUsageLimitPause>, 'get'>;
    sweepStale?: () => Promise<unknown>;
    state: CronStateStore;
    workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha'>;
    outbox: Pick<ReturnType<typeof createOutbox>, 'send'>;
    aliases: string[];
    intervalMs: number;
    logger?: Pick<Console, 'info' | 'warn'>;
  }) {
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;

  const tell = (text: string) =>
    outbox.send({ replyTo: OWNER, text }).catch((err) => logger.warn(`cron: outbox write failed: ${errorText(err)}`));

  /**
   * `rows` minus the issues whose open PR is parked, telling the owner once per parked state. A
   * failed lookup keeps every issue: better one empty run than a stalled cron.
   */
  async function skipParkedPrIssues(alias: string, repo: string, rows: OpenIssue[]) {
    let loaded;
    let attempted;
    let notified;
    try {
      loaded = await loadOpenAgentPrs(github, repo);
      [attempted, notified] = await Promise.all([state.prAttempts(), state.parkNotices()]);
    } catch (err) {
      logger.warn(`cron: open PR lookup failed for ${repo}: ${errorText(err)}`);
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
   * blocked PR is parked instead of re-run next tick. `reported`: the run's own message already
   * told the owner where this PR stands, so parking it in this state sends no second notice.
   */
  async function recordPrState(repo: string, issueNumber: number, reported: boolean) {
    try {
      const { openPrs, baseShaByBranch } = await loadOpenAgentPrs(github, repo);
      const pr = openPrs.get(issueNumber);
      if (!pr) return;
      const stateKey = prStateKey(pr, baseShaByBranch);
      await state.setPrAttempt(repo, issueNumber, stateKey);
      if (reported) await state.setParkNotice(repo, issueNumber, stateKey);
    } catch (err) {
      logger.warn(`cron: could not record the PR state of ${repo}#${issueNumber}: ${errorText(err)}`);
    }
  }

  async function runIssue(alias: string, repo: string, issue: OpenIssue): Promise<CronTickOutcome> {
    const started = await startIssueRun({ issueNumber: issue.number, alias, replyTo: OWNER, trigger: 'cron' });
    if (started.refused) return { kind: started.refused };
    const outcome: CronTickOutcome = { kind: 'ran', repo, issue: issue.number, result: 'prep_failed' };
    if (!started.done) {
      await tell(`Cron (${alias}): could not start #${issue.number} in ${repo}: ${truncate(started.reply)}`);
      return outcome;
    }
    // no PR attempt when the PR's state isn't a verdict on it: the merge is retried, or the run was cut short
    let skipPrAttempt = false;
    let progress = false;
    try {
      const run = await started.done;
      const result = run?.result;
      const mergeNetworkError = Boolean(run?.mergeNetworkError);
      skipPrAttempt = mergeNetworkError || result === 'limited';
      if (mergeNetworkError) {
        outcome.result = 'merge_retry';
        outcome.note = 'merge hit a network error';
        await tell(
          `Cron (${alias}): ${repo}#${issue.number} passed review, but its merge failed on a network error, so its PR is not set aside. The next tick works it again.`
        );
      } else if (result && PROGRESS.has(result)) {
        await state.setLastStarted(repo, issue.number);
        await state.clearNoChanges(repo, issue.number);
        outcome.result = 'progress';
        progress = true;
      } else {
        // failed, timeout, limited and no_changes stay distinct in the tick state; none of them is progress
        outcome.result = result || 'no_progress';
        if (!result) outcome.note = 'no result';
        // a failed or timed-out run has already reported to owner, but an empty one is silent
        if (result === 'no_changes') {
          const count = ((await state.noChanges()).get(issueKey(repo, issue.number)) ?? 0) + 1;
          await state.setNoChanges(repo, issue.number, count);
          await tell(
            count >= NO_CHANGES_LIMIT
              ? `Cron (${alias}): parking ${repo}#${issue.number}. It made no changes in ${count} runs in a row, so it may need no code. Close it or remove its ready-for-agent label.`
              : `Cron (${alias}): ${repo}#${issue.number} made no changes, so it doesn't count as progress. The next tick retries it.`
          );
        }
      }
    } catch (err) {
      const e = errorText(err);
      outcome.result = 'failed';
      outcome.note = truncate(e, 200);
      await tell(`Cron (${alias}): the run for ${repo}#${issue.number} failed: ${truncate(e)}`);
    } finally {
      if (!skipPrAttempt) await recordPrState(repo, issue.number, progress);
    }
    return outcome;
  }

  /**
   * One cron evaluation: skip while busy or paused, else run the first runnable issue found.
   */
  async function tick(): Promise<CronTickOutcome> {
    let phase = 'checking the lock';
    try {
      await sweepStale().catch((err) => logger.warn(`cron: stale active-run sweep failed: ${errorText(err)}`));
      if ((await pause.get()) || (await manualPause.general())) return { kind: 'paused' };
      if (await usageLimit.get()) return { kind: 'limited' };
      if (await lock.current()) return { kind: 'busy' };
      phase = 'reading cron state';
      const lastByRepo = await state.lastStarted();
      for (const alias of aliases) {
        let repo;
        try {
          const ws = await workspaces.resolveIssueWorkspace(alias);
          if (await manualPause.forWorkspace(ws.alias)) continue;
          repo = await github.resolveIssueRepo(ws.root, alias);
        } catch (err) {
          logger.warn(`cron: skipping workspace "${alias}": ${errorText(err)}`);
          continue;
        }
        phase = `listing open issues (${alias})`;
        const noChanges = await state.noChanges();
        const rows = (await skipParkedPrIssues(alias, repo, await github.listOpenIssues(repo))).filter(
          (r) => (noChanges.get(issueKey(repo, r.number)) ?? 0) < NO_CHANGES_LIMIT
        );
        phase = `checking issue dependencies (${alias})`;
        const next = await pickNextRunnableIssue(rows, repo, lastByRepo, github.blockedByCount);
        if (!next) continue;
        phase = `running ${repo}#${next.number}`;
        return await runIssue(alias, repo, next);
      }
      return { kind: 'no_eligible' };
    } catch (err) {
      const e = errorText(err);
      logger.warn(`cron: tick failed while ${phase}: ${e}`);
      await tell(`Cron tick failed while ${phase}: ${truncate(e)}`);
      return { kind: 'error', note: `${phase}: ${truncate(e, 200)}` };
    }
  }

  /**
   * A tick plus its record in Redis. Returns null (and does nothing) while a tick is in flight:
   * a tick lasts as long as the run it starts.
   */
  async function runOnce(): Promise<CronTickOutcome | null> {
    if (inFlight) return null;
    inFlight = true;
    const startedAt = Date.now();
    try {
      const outcome = await tick();
      await state.writeTick({ outcome, intervalMs, startedAt }).catch((err) => logger.warn(`cron: could not save the tick: ${errorText(err)}`));
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
      await state.writeStarted({ intervalMs }).catch((err) => logger.warn(`cron: could not save its state: ${errorText(err)}`));
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
