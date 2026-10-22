import { classifyReadyIssues, hasLabel } from './cronTracer.ts';
import { errorText } from './narrow.ts';
import type { createGithubIssues, OpenIssue } from './issuePipeline/githubIssue.ts';
import type { NotifyChange } from './stateChanges.ts';

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
 * A repo whose scan fails keeps its last good data, marked `stale` (so does every repo when the
 * allowlist can't be read). Errors are logged here, not put in the feed, which carries no paths.
 */
export type OfficeIssue = { number: number; title: string; url: string };

export type OfficeParkedIssue = OfficeIssue & { prUrl: string };

/**
 * One workspace's repo. `scannedAt`: when this data was read (null if it never has been).
 * `stale`: the latest scan of it failed, so this is older data. `runnable`, `blocked` and
 * `parked` are its `ready-for-agent` issues, and `parked` carries the open PR's link.
 */
export type OfficeIssueRepo = {
  alias: string;
  repo: string | null;
  scannedAt: string | null;
  stale: boolean;
  runnable: OfficeIssue[];
  blocked: OfficeIssue[];
  parked: OfficeParkedIssue[];
  readyForHuman: OfficeIssue[];
  needsTriage: number;
  needsInfo: number;
};

/** `scannedAt`: when the latest scan ended. `repos`: in the allowlist's (alias) order. */
export type OfficeIssues = { scannedAt: string; repos: OfficeIssueRepo[] };

export const ISSUE_SCAN_INTERVAL_MS = 5 * 60_000;

const byNumber = (a: { number: number }, b: { number: number }) => a.number - b.number;

const READY_FOR_HUMAN_LABEL = 'ready-for-human';
const NEEDS_TRIAGE_LABEL = 'needs-triage';
const NEEDS_INFO_LABEL = 'needs-info';

/** `prAttempts`: the cron's recorded PR attempts (`cronState.prAttempts`), read only. */
export function createIssueScan({ workspaces, github, prAttempts, intervalMs = ISSUE_SCAN_INTERVAL_MS, now = Date.now, onChange = () => {}, logger = console }: {
    workspaces: {
      aliases: () => Promise<string[]>;
      resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }>;
    };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha'>;
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
    const item = (r: OpenIssue): OfficeIssue => ({ number: r.number, title: r.title, url: `https://github.com/${repo}/issues/${r.number}` });
    const titles = new Map(rows.map((r) => [r.number, r.title]));
    const labelled = (label: string) => rows.filter((r) => hasLabel(r, label)).sort(byNumber);
    return {
      alias,
      repo,
      scannedAt,
      stale: false,
      runnable: ready.runnable.map(item),
      blocked: ready.blocked.map(item),
      parked: ready.parked
        .map((p) => ({ ...item({ number: p.number, title: titles.get(p.number) ?? '', labels: [] }), prUrl: p.url })),
      readyForHuman: labelled(READY_FOR_HUMAN_LABEL).map(item),
      needsTriage: labelled(NEEDS_TRIAGE_LABEL).length,
      needsInfo: labelled(NEEDS_INFO_LABEL).length,
    };
  }

  /** @returns the repo's last good data, marked stale */
  function staleRepo(alias: string): OfficeIssueRepo {
    const last = result?.repos.find((r) => r.alias === alias);
    if (last) return { ...last, stale: true };
    return { alias, repo: null, scannedAt: null, stale: true, runnable: [], blocked: [], parked: [], readyForHuman: [], needsTriage: 0, needsInfo: 0 };
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
