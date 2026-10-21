import { randomUUID } from 'crypto';

/**
 * Runner-wide pause flag in Redis. While it is set the runner starts no new runs (and the cron
 * skips its ticks). Whoever sets it gets a token and only that token clears it, so
 * the runner never clears a pause it didn't set, e.g. on startup mid safe-restart. The TTL is a
 * safety net for a setter that dies before clearing.
 *
 * @typedef {{ token: string | null, reason: string, pausedAt: string | null }} PauseRecord
 */

export const PAUSE_KEY = 'agent-runner:paused';
export const DEFAULT_PAUSE_TTL_SECONDS = 10 * 60;

/**
 * @param {{ store: import('./redisStore.js').Store, ttlSeconds?: number, key?: string, now?: () => number }} p
 */
export function createPauseFlag({ store, ttlSeconds = DEFAULT_PAUSE_TTL_SECONDS, key = PAUSE_KEY, now = Date.now }) {
  return {
    /** @param {string} reason @returns {Promise<string | null>} token, or null if already paused */
    async set(reason) {
      const token = randomUUID();
      const record = { token, reason, pausedAt: new Date(now()).toISOString() };
      return (await store.setIfAbsent(key, JSON.stringify(record), ttlSeconds)) ? token : null;
    },
    /** @param {string} token @returns {Promise<boolean>} */
    clear: (token) => store.deleteIfField(key, 'token', token),
    /** @returns {Promise<PauseRecord | null>} */
    async get() {
      const raw = await store.get(key);
      if (raw == null) return null;
      try {
        const rec = JSON.parse(raw);
        return {
          token: typeof rec.token === 'string' ? rec.token : null,
          reason: typeof rec.reason === 'string' ? rec.reason : 'unknown',
          pausedAt: typeof rec.pausedAt === 'string' ? rec.pausedAt : null,
        };
      } catch {
        return { token: null, reason: 'unknown', pausedAt: null };
      }
    },
  };
}
