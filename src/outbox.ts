/**
 * Runner → bot messages: a Redis Stream the bot reads with its own cursor. The runner never knows
 * about WhatsApp. `replyTo` is opaque (echoed from `POST /command`), and system/cron messages go
 * to the logical `owner`.
 */

export const OUTBOX_KEY = 'agent-runner:outbox';
export const OWNER = 'owner';
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {{ store: import('./redisStore.js').Store, key?: string, retentionMs?: number, now?: () => number }} p
 */
export function createOutbox({ store, key = OUTBOX_KEY, retentionMs = OUTBOX_RETENTION_MS, now = Date.now }) {
  return {
    /**
     * @param {{ replyTo: string, text: string, runId?: string | null }} msg
     * @returns {Promise<string>} stream entry id
     */
    async send({ replyTo, text, runId }) {
      if (!replyTo) throw new Error('outbox: replyTo is required');
      const t = now();
      return store.appendToStream(
        key,
        { replyTo, text: String(text), runId: runId ?? '', ts: new Date(t).toISOString() },
        { minIdMs: t - retentionMs }
      );
    },
  };
}
