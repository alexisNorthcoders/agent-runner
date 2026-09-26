import { hasLabel, isBlocked, loadOpenAgentPrs, partitionIssuesWithOpenPr, readyForAgent } from './cronTracer.js';
import { errorMessageFromUnknown } from './issuePipeline/index.js';

/**
 * The issue scan: the work waiting in each allowlisted workspace's GitHub repo, for the office
 * (the in-trays, sticky notes and parked folders, and the Issues tab). It lists each repo's open
 * issues with `gh` on startup, every `intervalMs` and after each run, and caches the result for
 * the office feed, so the page never talks to GitHub.
 *
 * `ready-for-agent` issues are split the way the cron issue tracer (src/cronTracer.js) would see
 * them, with its own helpers: **parked** (an open agent PR whose current state the cron already
 * attempted), **blocked** (an open native dependency, or a failed lookup), else **runnable**. The
 * scan only reads the cron's PR attempts; it never writes cron state.
 *
 * A repo whose scan fails keeps its last good data, marked `stale` (so does every repo when the
 * allowlist can't be read). Errors are logged here, not put in the feed, which carries no paths.
 *
 * @typedef {{ number: number, title: string, url: string }} OfficeIssue
 * @typedef {OfficeIssue & { prUrl: string }} OfficeParkedIssue
 *
 * @typedef {{
 *   alias: string,
 *   repo: string | null,
 *   scannedAt: string | null,
 *   stale: boolean,
 *   runnable: OfficeIssue[],
 *   blocked: OfficeIssue[],
 *   parked: OfficeParkedIssue[],
 *   readyForHuman: OfficeIssue[],
 *   needsTriage: number,
 *   needsInfo: number,
 * }} OfficeIssueRepo
 *   One workspace's repo. `scannedAt`: when this data was read (null if it never has been).
 *   `stale`: the latest scan of it failed, so this is older data. `runnable`, `blocked` and
 *   `parked` are its `ready-for-agent` issues, and `parked` carries the open PR's link.
 *
 * @typedef {{ scannedAt: string, repos: OfficeIssueRepo[] }} OfficeIssues
 *   `scannedAt`: when the latest scan ended. `repos`: in the allowlist's (alias) order.
 */

export const ISSUE_SCAN_INTERVAL_MS = 5 * 60_000;

/** @param {{ number: number }} a @param {{ number: number }} b */
const byNumber = (a, b) => a.number - b.number;

const READY_FOR_HUMAN_LABEL = 'ready-for-human';
const NEEDS_TRIAGE_LABEL = 'needs-triage';
const NEEDS_INFO_LABEL = 'needs-info';

/**
 * @param {{
 *   workspaces: {
 *     aliases: () => Promise<string[]>,
 *     resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string, root: string }>,
 *   },
 *   github: Pick<ReturnType<typeof import('./issuePipeline/githubIssue.js').createGithubIssues>,
 *     'resolveIssueRepo' | 'listOpenIssues' | 'blockedByCount' | 'listOpenAgentPrsByIssue' | 'branchHeadSha'>,
 *   prAttempts: () => Promise<Map<string, string>>,
 *   intervalMs?: number,
 *   now?: () => number,
 *   onChange?: import('./stateChanges.js').NotifyChange,
 *   logger?: Pick<Console, 'info' | 'warn'>,
 * }} deps
 *   `prAttempts`: the cron's recorded PR attempts (`cronState.prAttempts`), read only.
 */
export function createIssueScan({ workspaces, github, prAttempts, intervalMs = ISSUE_SCAN_INTERVAL_MS, now = Date.now, onChange = () => {}, logger = console }) {
  /** @type {OfficeIssues | null} */
  let result = null;
  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /**
   * @param {string} alias
   * @param {string} scannedAt
   * @returns {Promise<OfficeIssueRepo>}
   */
  async function scanRepo(alias, scannedAt) {
    const ws = await workspaces.resolveIssueWorkspace(alias);
    const repo = await github.resolveIssueRepo(ws.root, alias);
    const rows = await github.listOpenIssues(repo);
    const { openPrs, baseShaByBranch } = await loadOpenAgentPrs(github, repo);
    const { rows: kept, parked } = partitionIssuesWithOpenPr(rows, repo, openPrs, baseShaByBranch, await prAttempts());
    /** @param {import('./issuePipeline/githubIssue.js').OpenIssue} r @returns {OfficeIssue} */
    const item = (r) => ({ number: r.number, title: r.title, url: `https://github.com/${repo}/issues/${r.number}` });
    const titles = new Map(rows.map((r) => [r.number, r.title]));
    /** @type {OfficeIssue[]} */
    const runnable = [];
    /** @type {OfficeIssue[]} */
    const blocked = [];
    for (const r of readyForAgent(kept).sort(byNumber)) {
      ((await isBlocked(github.blockedByCount, repo, r.number)) ? blocked : runnable).push(item(r));
    }
    const labelled = (/** @type {string} */ label) => rows.filter((r) => hasLabel(r, label)).sort(byNumber);
    return {
      alias,
      repo,
      scannedAt,
      stale: false,
      runnable,
      blocked,
      parked: parked
        .sort(byNumber)
        .map((p) => ({ ...item({ number: p.number, title: titles.get(p.number) ?? '', labels: [] }), prUrl: p.url })),
      readyForHuman: labelled(READY_FOR_HUMAN_LABEL).map(item),
      needsTriage: labelled(NEEDS_TRIAGE_LABEL).length,
      needsInfo: labelled(NEEDS_INFO_LABEL).length,
    };
  }

  /** @param {string} alias @returns {OfficeIssueRepo} the repo's last good data, marked stale */
  function staleRepo(alias) {
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
      logger.warn(`issue scan: cannot read the workspace allowlist: ${errorMessageFromUnknown(err)}`);
      result = { scannedAt, repos: (result?.repos ?? []).map((r) => ({ ...r, stale: true })) };
      onChange('issue-scan');
      return;
    }
    /** @type {OfficeIssueRepo[]} */
    const repos = [];
    for (const alias of aliases) {
      try {
        repos.push(await scanRepo(alias, scannedAt));
      } catch (err) {
        logger.warn(`issue scan: ${alias} failed, keeping its last data: ${errorMessageFromUnknown(err)}`);
        repos.push(staleRepo(alias));
      }
    }
    result = { scannedAt, repos };
    onChange('issue-scan');
  }

  /**
   * Scan every workspace's repo. One scan runs at a time: asked for while one runs, it runs once
   * more after it, and the promise settles when that one has.
   * @returns {Promise<void>}
   */
  function scan() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await scanOnce().catch((err) => logger.warn(`issue scan failed: ${errorMessageFromUnknown(err)}`));
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    scan,

    /** The latest scan, or null before the first one ends. @returns {OfficeIssues | null} */
    current: () => result,

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
