/**
 * FIFO of run requests that arrived while the agent was busy (or the runner paused), in Redis so it
 * survives a restart. The runner starts them one at a time, oldest first, as each run finishes.
 *
 * @typedef {{
 *   id: string,
 *   cmd: { kind: 'freeform', prompt: string }
 *     | { kind: 'joplin', noteQuery: string }
 *     | { kind: 'issue', issueNumber: number, alias: string | null, extraInstructions: string }
 *     | { kind: 'job', job: import('./scheduledJobs.js').ScheduledJob },
 *   replyTo: string,
 *   label: string,
 *   queuedAt: string,
 * }} QueuedRun
 */

export const QUEUE_KEY = 'agent-runner:queue';
export const MAX_QUEUE_LENGTH = 20;

/** @param {string} raw @returns {QueuedRun | null} */
function parse(raw) {
  try {
    const item = JSON.parse(raw);
    if (item && typeof item.replyTo === 'string' && item.cmd && typeof item.cmd.kind === 'string') return item;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * @param {{ store: import('./redisStore.js').Store, key?: string, maxLength?: number }} p
 */
export function createRunQueue({ store, key = QUEUE_KEY, maxLength = MAX_QUEUE_LENGTH }) {
  return {
    maxLength,
    /**
     * Append to the back. The length check and push aren't atomic, which is fine: only the runner
     * process pushes.
     * @param {QueuedRun} item
     * @returns {Promise<number | null>} the item's 1-based position, or null when the queue is full
     */
    async push(item) {
      if ((await store.listLength(key)) >= maxLength) return null;
      return store.listPushBack(key, JSON.stringify(item));
    },
    /** Take the oldest item, skipping unreadable ones. @returns {Promise<QueuedRun | null>} */
    async shift() {
      for (;;) {
        const raw = await store.listPopFront(key);
        if (raw == null) return null;
        const item = parse(raw);
        if (item) return item;
      }
    },
    /** Put an item back at the front (it was taken but couldn't start). @param {QueuedRun} item */
    async unshift(item) {
      await store.listPushFront(key, JSON.stringify(item));
    },
    /** @returns {Promise<QueuedRun[]>} oldest first */
    async list() {
      return (await store.listAll(key)).map(parse).filter((x) => x !== null);
    },
    length: () => store.listLength(key),
    clear: () => store.del(key),
  };
}
