/**
 * The cron issue tracer's state, in Redis so the bot, the CLIs and a restarted runner all see it.
 * It starts fresh: nothing is migrated from the bot's JSON files.
 *
 * - `agent-runner:cron:state` (string, JSON): the last tick, for `claude:status` and the terminal
 *   CLIs. `pid` is the process running the cron, so readers can tell a dead cron from an idle one,
 *   and `intervalMs` lets them predict the next tick.
 * - `agent-runner:cron:last-started` (hash `owner/repo` → issue number): the last issue per repo
 *   the cron made lasting progress on, which it doesn't pick again.
 * - `agent-runner:cron:pr-attempts` (hash `owner/repo#n` → PR state): the state an open agent PR was
 *   left in by the last cron attempt. The cron retries a PR only once per state.
 * - `agent-runner:cron:park-notices` (hash `owner/repo#n` → PR state): the parked PR state the owner
 *   was last told about, so they hear about it once.
 * - `agent-runner:cron:no-changes` (hash `owner/repo#n` → count): consecutive runs of an issue that
 *   made no changes. At the limit the cron parks the issue; any lasting progress resets it.
 */

import { isRecord, parseJsonObject, stringOrNull } from './narrow.ts';
import type { Store } from './redisStore.ts';
import type { CronTickOutcome } from './officeWire.ts';

export type CronState = {
  pid: number;
  intervalMs: number;
  lastTickStartedAt: string | null;
  lastTickEndedAt: string | null;
  outcome: CronTickOutcome | null;
};

export const CRON_STATE_KEY = 'agent-runner:cron:state';
export const CRON_LAST_STARTED_KEY = 'agent-runner:cron:last-started';
export const CRON_PR_ATTEMPTS_KEY = 'agent-runner:cron:pr-attempts';
export const CRON_PARK_NOTICES_KEY = 'agent-runner:cron:park-notices';
export const CRON_NO_CHANGES_KEY = 'agent-runner:cron:no-changes';

function parseOutcome(v: unknown): CronTickOutcome | null {
  if (!isRecord(v) || typeof v.kind !== 'string') return null;
  const out: CronTickOutcome = { kind: v.kind };
  if (typeof v.repo === 'string') out.repo = v.repo;
  if (typeof v.issue === 'number') out.issue = v.issue;
  if (typeof v.result === 'string') out.result = v.result;
  if (typeof v.note === 'string') out.note = v.note;
  return out;
}

/** The cron state value, or null without a numeric `pid` and `intervalMs`. */
function parseCronState(raw: string): CronState | null {
  const o = parseJsonObject(raw);
  if (typeof o?.pid !== 'number' || typeof o.intervalMs !== 'number') return null;
  return {
    pid: o.pid,
    intervalMs: o.intervalMs,
    lastTickStartedAt: stringOrNull(o.lastTickStartedAt),
    lastTickEndedAt: stringOrNull(o.lastTickEndedAt),
    outcome: parseOutcome(o.outcome),
  };
}

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const ISSUE_KEY_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#\d+$/;

/**
 * The state of an open agent PR that a cron attempt has worked on: its head commit and its base
 * branch's tip. A PR that stays blocked is not re-run every tick, but gets another go when either
 * side moves.
 */
export const prAttemptStateKey = (pr: { headSha: string }, baseSha: string) => `${pr.headSha}:${baseSha}`;

/**
 * `owner/repo#n`, the field for an issue in the cron's hashes. Throws on a bad slug or number, so
 * nothing corrupt is stored.
 */
export function issueKey(repo: string, number: number) {
  if (!REPO_SLUG_RE.test(repo)) throw new TypeError(`cron state: invalid repo slug ${JSON.stringify(repo)} (expected owner/name)`);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`cron state: invalid issue number ${number}`);
  return `${repo}#${number}`;
}

export function createCronState({ store, now = Date.now, pid = process.pid }: { store: Store; now?: () => number; pid?: number }) {
  async function issueMap(key: string): Promise<Map<string, string>> {
    const all = await store.hashGetAll(key);
    return new Map(Object.entries(all).filter(([k]) => ISSUE_KEY_RE.test(k)));
  }

  return {
    async read(): Promise<CronState | null> {
      const raw = await store.get(CRON_STATE_KEY);
      return raw == null ? null : parseCronState(raw);
    },

    /** Forget the last tick, e.g. when the cron is disabled, so status doesn't show a dead cron. */
    clear: () => store.del(CRON_STATE_KEY),

    /** The cron has started and not ticked yet. */
    async writeStarted({ intervalMs }: { intervalMs: number }) {
      const state: CronState = { pid, intervalMs, lastTickStartedAt: null, lastTickEndedAt: null, outcome: null };
      await store.set(CRON_STATE_KEY, JSON.stringify(state));
    },

    async writeTick({ outcome, intervalMs, startedAt }: { outcome: CronTickOutcome; intervalMs: number; startedAt: number }) {
      const state: CronState = {
        pid,
        intervalMs,
        lastTickStartedAt: new Date(startedAt).toISOString(),
        lastTickEndedAt: new Date(now()).toISOString(),
        outcome,
      };
      await store.set(CRON_STATE_KEY, JSON.stringify(state));
    },

    /** @returns `owner/repo` → last started issue */
    async lastStarted(): Promise<Map<string, number>> {
      const out: Map<string, number> = new Map();
      for (const [repo, v] of Object.entries(await store.hashGetAll(CRON_LAST_STARTED_KEY))) {
        const n = Number(v);
        if (REPO_SLUG_RE.test(repo) && Number.isInteger(n) && n >= 1) out.set(repo, n);
      }
      return out;
    },

    async setLastStarted(repo: string, number: number) {
      issueKey(repo, number); // validates
      await store.hashSet(CRON_LAST_STARTED_KEY, repo, String(number));
    },

    /** @returns `owner/repo#n` → PR state last attempted */
    prAttempts: (): Promise<Map<string, string>> => issueMap(CRON_PR_ATTEMPTS_KEY),

    setPrAttempt: (repo: string, number: number, stateKey: string) => store.hashSet(CRON_PR_ATTEMPTS_KEY, issueKey(repo, number), stateKey),

    /** @returns `owner/repo#n` → parked PR state the owner was told about */
    parkNotices: (): Promise<Map<string, string>> => issueMap(CRON_PARK_NOTICES_KEY),

    setParkNotice: (repo: string, number: number, stateKey: string) => store.hashSet(CRON_PARK_NOTICES_KEY, issueKey(repo, number), stateKey),

    /** @returns `owner/repo#n` → consecutive no-change runs */
    async noChanges(): Promise<Map<string, number>> {
      const out: Map<string, number> = new Map();
      for (const [k, v] of await issueMap(CRON_NO_CHANGES_KEY)) {
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1) out.set(k, n);
      }
      return out;
    },

    setNoChanges: (repo: string, number: number, count: number) => store.hashSet(CRON_NO_CHANGES_KEY, issueKey(repo, number), String(count)),

    clearNoChanges: (repo: string, number: number) => store.hashDelete(CRON_NO_CHANGES_KEY, issueKey(repo, number)),

    /** The PR is no longer parked. */
    clearParkNotice: (repo: string, number: number) => store.hashDelete(CRON_PARK_NOTICES_KEY, issueKey(repo, number)),
  };
}

export type CronStateStore = ReturnType<typeof createCronState>;
