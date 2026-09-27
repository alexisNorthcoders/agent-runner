/**
 * The usage-limit pause: set when an agent run ends on its usage limit, it holds every new run
 * (requests and scheduled jobs queue, the cron skips its ticks) until the limit resets. Separate
 * from the safe-restart flag (`pauseFlag.js`) and the owner's pauses (`manualPause.js`).
 *
 * One Redis key whose TTL ends with the pause, so it expires on its own; its end time is inside too,
 * and a pause past it reads as absent. Setting it only ever extends it. The read and write aren't
 * atomic, which is fine: only the runner process sets it. The owner can end it early with
 * `claude:resume` (no alias), e.g. after a plan upgrade.
 *
 * @typedef {{ until: string, note: string | null, timeZone: string | null, since: string }} UsageLimitPause
 *   `note` and `timeZone` are how the agent put the reset (e.g. `resets 7am Europe/London`), when known.
 */

export const USAGE_LIMIT_KEY = 'agent-runner:usage-limit';

/** @param {string} raw @returns {UsageLimitPause | null} */
function parse(raw) {
  try {
    const p = JSON.parse(raw);
    if (p && typeof p.until === 'string') return { note: null, timeZone: null, since: p.until, ...p };
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * @param {{ store: import('./redisStore.js').Store, key?: string, now?: () => number }} p
 */
export function createUsageLimitPause({ store, key = USAGE_LIMIT_KEY, now = Date.now }) {
  /** @returns {Promise<UsageLimitPause | null>} the live pause, if any */
  async function get() {
    const raw = await store.get(key);
    const p = raw == null ? null : parse(raw);
    return p && Date.parse(p.until) > now() ? p : null;
  }

  return {
    get,
    /**
     * Hold runs until `limit.resetsAt`, unless a pause already runs at least that long.
     * @param {import('./agentBackend/index.js').AgentUsageLimit} limit
     * @returns {Promise<{ pause: UsageLimitPause | null, extended: boolean }>} the pause in force after
     */
    async extend({ resetsAt, note, timeZone }) {
      const cur = await get();
      const end = Date.parse(resetsAt);
      const ms = end - now();
      if (!(ms > 0) || (cur && Date.parse(cur.until) >= end)) return { pause: cur, extended: false };
      const p = { until: new Date(end).toISOString(), note, timeZone, since: new Date(now()).toISOString() };
      await store.setWithTtl(key, JSON.stringify(p), Math.ceil(ms / 1000));
      return { pause: p, extended: true };
    },
    /** End the pause early (`claude:resume`). @returns {Promise<boolean>} whether a live pause was cleared */
    async clear() {
      // an expired key goes with its TTL; deleting only a live one keeps the office feed quiet
      if (!(await get())) return false;
      await store.del(key);
      return true;
    },
  };
}

/**
 * e.g. `until 07:02 (resets 7am Europe/London)`, in the zone the agent named (else the runner's),
 * with the date when it isn't the same day as `nowMs`.
 * @param {UsageLimitPause} p
 * @param {number} [nowMs]
 */
export function describeUsageLimitPause(p, nowMs = Date.now()) {
  const timeZone = p.timeZone ?? undefined;
  const at = Date.parse(p.until);
  /** @param {number} ms @param {Intl.DateTimeFormatOptions} o */
  const parts = (ms, o) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, ...o }).formatToParts(ms).map((x) => [x.type, x.value]));
  const t = parts(at, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short', day: 'numeric', month: 'short' });
  const today = parts(nowMs, { day: 'numeric', month: 'short' });
  const date = t.day === today.day && t.month === today.month ? '' : `${t.weekday} ${t.day} ${t.month} `;
  return `until ${date}${t.hour}:${t.minute}${p.note ? ` (${p.note})` : ''}`;
}
