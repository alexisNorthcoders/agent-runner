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
 *
 * @typedef {{
 *   kind: 'busy' | 'paused' | 'no_eligible' | 'ran' | 'error' | string,
 *   repo?: string,
 *   issue?: number,
 *   result?: string,
 *   note?: string,
 * }} CronTickOutcome
 *
 * @typedef {{
 *   pid: number,
 *   intervalMs: number,
 *   lastTickStartedAt: string | null,
 *   lastTickEndedAt: string | null,
 *   outcome: CronTickOutcome | null,
 * }} CronState
 */

export const CRON_STATE_KEY = 'agent-runner:cron:state';
export const CRON_LAST_STARTED_KEY = 'agent-runner:cron:last-started';
export const CRON_PR_ATTEMPTS_KEY = 'agent-runner:cron:pr-attempts';
export const CRON_PARK_NOTICES_KEY = 'agent-runner:cron:park-notices';

const REPO_SLUG_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const ISSUE_KEY_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#\d+$/;

/**
 * The state of an open agent PR that a cron attempt has worked on: its head commit and its base
 * branch's tip. A PR that stays blocked is not re-run every tick, but gets another go when either
 * side moves.
 * @param {{ headSha: string }} pr
 * @param {string} baseSha
 */
export const prAttemptStateKey = (pr, baseSha) => `${pr.headSha}:${baseSha}`;

/** @param {string} repo @param {number} number */
function issueKey(repo, number) {
  if (!REPO_SLUG_RE.test(repo)) throw new TypeError(`cron state: invalid repo slug ${JSON.stringify(repo)} (expected owner/name)`);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`cron state: invalid issue number ${number}`);
  return `${repo}#${number}`;
}

/**
 * @param {{ store: import('./redisStore.js').Store, now?: () => number, pid?: number }} p
 */
export function createCronState({ store, now = Date.now, pid = process.pid }) {
  /** @param {string} key @returns {Promise<Map<string, string>>} */
  async function issueMap(key) {
    const all = await store.hashGetAll(key);
    return new Map(Object.entries(all).filter(([k]) => ISSUE_KEY_RE.test(k)));
  }

  return {
    /** @returns {Promise<CronState | null>} */
    async read() {
      const raw = await store.get(CRON_STATE_KEY);
      if (raw == null) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    /** The cron has started and not ticked yet. @param {{ intervalMs: number }} p */
    async writeStarted({ intervalMs }) {
      /** @type {CronState} */
      const state = { pid, intervalMs, lastTickStartedAt: null, lastTickEndedAt: null, outcome: null };
      await store.set(CRON_STATE_KEY, JSON.stringify(state));
    },

    /** @param {{ outcome: CronTickOutcome, intervalMs: number, startedAt: number }} p */
    async writeTick({ outcome, intervalMs, startedAt }) {
      /** @type {CronState} */
      const state = {
        pid,
        intervalMs,
        lastTickStartedAt: new Date(startedAt).toISOString(),
        lastTickEndedAt: new Date(now()).toISOString(),
        outcome,
      };
      await store.set(CRON_STATE_KEY, JSON.stringify(state));
    },

    /** @returns {Promise<Map<string, number>>} `owner/repo` → last started issue */
    async lastStarted() {
      /** @type {Map<string, number>} */
      const out = new Map();
      for (const [repo, v] of Object.entries(await store.hashGetAll(CRON_LAST_STARTED_KEY))) {
        const n = Number(v);
        if (REPO_SLUG_RE.test(repo) && Number.isInteger(n) && n >= 1) out.set(repo, n);
      }
      return out;
    },

    /** @param {string} repo @param {number} number */
    async setLastStarted(repo, number) {
      issueKey(repo, number);
      await store.hashSet(CRON_LAST_STARTED_KEY, repo, String(number));
    },

    /** @returns {Promise<Map<string, string>>} `owner/repo#n` → PR state last attempted */
    prAttempts: () => issueMap(CRON_PR_ATTEMPTS_KEY),

    /** @param {string} repo @param {number} number @param {string} stateKey */
    setPrAttempt: (repo, number, stateKey) => store.hashSet(CRON_PR_ATTEMPTS_KEY, issueKey(repo, number), stateKey),

    /** @returns {Promise<Map<string, string>>} `owner/repo#n` → parked PR state the owner was told about */
    parkNotices: () => issueMap(CRON_PARK_NOTICES_KEY),

    /** @param {string} repo @param {number} number @param {string} stateKey */
    setParkNotice: (repo, number, stateKey) => store.hashSet(CRON_PARK_NOTICES_KEY, issueKey(repo, number), stateKey),
  };
}

/** @typedef {ReturnType<typeof createCronState>} CronStateStore */
