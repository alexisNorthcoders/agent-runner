/**
 * The issue scan: the work waiting in each allowlisted workspace's GitHub repo, for the office
 * (the in-trays, sticky notes and parked folders, and the Issues tab). It lists each repo's open
 * issues with `gh` on startup, every `intervalMs` and after each run, and caches the result for
 * the office feed, so the page never talks to GitHub.
 *
 * `ready-for-agent` issues are split the way the cron issue tracer (src/cronTracer.ts) would see
 * them, with its own helpers: **parked** (an open agent PR whose current state the cron already
 * attempted), **blocked** (an open native dependency, or a failed lookup), else **runnable**. The
 * scan only reads the cron's PR attempts; it never writes cron state.
 *
 * The `agent-suggested` + `needs-triage` issues are split by the decision log `issue_grill` checks
 * for (src/issueGrill.ts): grilled ones are specs to review, the rest are the grill queue.
 *
 * A repo whose scan fails keeps its last good data, marked `stale` (so does every repo when the
 * allowlist can't be read). Errors are logged here, not put in the feed, which carries no paths.
 */

import { classifyReadyIssues, hasLabel } from './cronTracer.ts';
import { latestGrillLog, lowConfidenceCount } from './issueGrill.ts';
import { errorText } from './narrow.ts';
import { AGENT_SUGGESTED_LABEL, NEEDS_TRIAGE_LABEL } from './issuePipeline/githubIssue.ts';
import type { createGithubIssues } from './issuePipeline/githubIssue.ts';
import type { NotifyChange } from './stateChanges.ts';
import type { OfficeIssue, OfficeIssueRepo, OfficeIssues, OfficeSpec } from './officeWire.ts';

export const ISSUE_SCAN_INTERVAL_MS = 5 * 60_000;

const byNumber = (a: { number: number }, b: { number: number }) => a.number - b.number;

const READY_FOR_HUMAN_LABEL = 'ready-for-human';
const NEEDS_INFO_LABEL = 'needs-info';

/** `prAttempts`: the cron's recorded PR attempts (`cronState.prAttempts`), read only. */
export function createIssueScan({ workspaces, github, prAttempts, intervalMs = ISSUE_SCAN_INTERVAL_MS, now = Date.now, onChange = () => {}, logger = console }: {
    workspaces: {
      aliases: () => Promise<string[]>;
      resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }>;
    };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'listOpenIssues' | 'listTriageSuggestions' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha'>;
    prAttempts: () => Promise<Map<string, string>>;
    intervalMs?: number;
    now?: () => number;
    onChange?: NotifyChange;
    logger?: Pick<Console, 'info' | 'warn'>;
  }) {
  let result: OfficeIssues | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  async function scanRepo(alias: string, scannedAt: string): Promise<OfficeIssueRepo> {
    const ws = await workspaces.resolveIssueWorkspace(alias);
    const repo = await github.resolveIssueRepo(ws.root, alias);
    const rows = await github.listOpenIssues(repo);
    const ready = await classifyReadyIssues(github, repo, rows, await prAttempts());
    const item = (r: { number: number; title: string }): OfficeIssue => ({ number: r.number, title: r.title, url: `https://github.com/${repo}/issues/${r.number}` });
    const titles = new Map(rows.map((r) => [r.number, r.title]));
    const labelled = (label: string) => rows.filter((r) => hasLabel(r, label)).sort(byNumber);
    const specsToReview: OfficeSpec[] = [];
    const grillQueue: OfficeIssue[] = [];
    for (const sug of (await github.listTriageSuggestions(repo)).sort(byNumber)) {
      const log = latestGrillLog(sug.comments);
      if (log) specsToReview.push({ ...item(sug), lowConfidence: lowConfidenceCount(log) });
      else grillQueue.push(item(sug));
    }
    return {
      alias,
      repo,
      scannedAt,
      stale: false,
      runnable: ready.runnable.map(item),
      blocked: ready.blocked.map(item),
      parked: ready.parked
        .map((p) => ({ ...item({ number: p.number, title: titles.get(p.number) ?? '' }), prUrl: p.url })),
      readyForHuman: labelled(READY_FOR_HUMAN_LABEL).map(item),
      specsToReview,
      grillQueue,
      needsTriage: labelled(NEEDS_TRIAGE_LABEL).filter((r) => !hasLabel(r, AGENT_SUGGESTED_LABEL)).map(item),
      needsInfo: labelled(NEEDS_INFO_LABEL).map(item),
    };
  }

  /** @returns the repo's last good data, marked stale */
  function staleRepo(alias: string): OfficeIssueRepo {
    const last = result?.repos.find((r) => r.alias === alias);
    if (last) return { ...last, stale: true };
    return { alias, repo: null, scannedAt: null, stale: true, runnable: [], blocked: [], parked: [], readyForHuman: [], specsToReview: [], grillQueue: [], needsTriage: [], needsInfo: [] };
  }

  async function scanOnce() {
    const scannedAt = new Date(now()).toISOString();
    let aliases;
    try {
      aliases = await workspaces.aliases();
    } catch (err) {
      logger.warn(`issue scan: cannot read the workspace allowlist: ${errorText(err)}`);
      result = { scannedAt, repos: (result?.repos ?? []).map((r) => ({ ...r, stale: true })) };
      onChange('issue-scan');
      return;
    }
    const repos: OfficeIssueRepo[] = [];
    for (const alias of aliases) {
      try {
        repos.push(await scanRepo(alias, scannedAt));
      } catch (err) {
        logger.warn(`issue scan: ${alias} failed, keeping its last data: ${errorText(err)}`);
        repos.push(staleRepo(alias));
      }
    }
    result = { scannedAt, repos };
    onChange('issue-scan');
  }

  /**
   * Scan every workspace's repo. One scan runs at a time: asked for while one runs, it runs once
   * more after it, and the promise settles when that one has.
   */
  function scan(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await scanOnce().catch((err) => logger.warn(`issue scan failed: ${errorText(err)}`));
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    scan,

    /** The latest scan, or null before the first one ends. */
    current: (): OfficeIssues | null => result,

    /** Scan now, then every `intervalMs`. */
    start() {
      if (timer) return;
      timer = setInterval(() => void scan(), intervalMs);
      timer.unref();
      logger.info(`agent-runner: issue scan every ${Math.round(intervalMs / 1000)}s`);
      void scan();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
