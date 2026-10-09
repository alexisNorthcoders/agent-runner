/**
 * The Parent run a `claude:more` request continues, as picked when it was submitted (so a run that
 * finishes while it waits doesn't change it). `pending`: the Parent was still running when the
 * request arrived, so `sessionId` and `endedAt` are read from its history row when this starts.
 * @typedef {{
 *   runId: string,
 *   kind: 'freeform' | 'joplin',
 *   label: string,
 *   sessionId: string,
 *   cwd: string,
 *   endedAt: string,
 *   inferredWorkspace?: string,
 * } | {
 *   runId: string,
 *   kind: 'freeform' | 'joplin',
 *   label: string,
 *   cwd: string,
 *   pending: true,
 * }} ContinuationParent
 */

/**
 * FIFO of run requests that arrived while the agent was busy (or the runner paused), in Redis so it
 * survives a restart. The runner starts them one at a time, oldest first, as each run finishes. A
 * manual request the usage limit stopped before it started goes back to the front.
 *
 * @typedef {{
 *   id: string,
 *   cmd: { kind: 'freeform', prompt: string, model?: string }
 *     | { kind: 'joplin', noteQuery: string, model?: string }
 *     | { kind: 'more', instructions: string, parent: ContinuationParent }
 *     | { kind: 'issue', issueNumber: number, alias: string | null, extraInstructions: string }
 *     | { kind: 'job', job: import('./scheduledJobs.js').ScheduledJob },
 *   replyTo: string,
 *   label: string,
 *   queuedAt: string,
 * }} QueuedRun
 */

export const QUEUE_KEY = 'agent-runner:queue';
export const MAX_QUEUE_LENGTH = 20;

/** A report's line for a request the usage limit stopped before it started, re-queued at the front. */
export const REQUEUED_NOTE = 'It is back at the head of the queue, and runs again once the limit resets.';

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
    /**
     * Put an item at the front: it was taken but couldn't start, or the usage limit stopped its run
     * before it started. No length check, as it had a place already.
     * @param {QueuedRun} item
     */
    async unshift(item) {
      await store.listPushFront(key, JSON.stringify(item));
    },
    /**
     * Rewrite a waiting item in place, keeping its position. The change is dropped (null) when the
     * item is no longer waiting, e.g. it was just taken to start.
     * @param {string} id
     * @param {(item: QueuedRun) => QueuedRun} change
     * @returns {Promise<{ item: QueuedRun, position: number } | null>}
     */
    async update(id, change) {
      const raws = await store.listAll(key);
      for (let i = 0; i < raws.length; i++) {
        const old = parse(raws[i]);
        if (old?.id !== id) continue;
        const item = change(old);
        return (await store.listReplaceAt(key, i, raws[i], JSON.stringify(item))) ? { item, position: i + 1 } : null;
      }
      return null;
    },
    /** @returns {Promise<QueuedRun[]>} front first */
    async list() {
      return (await store.listAll(key)).map(parse).filter((x) => x !== null);
    },
    length: () => store.listLength(key),
    clear: () => store.del(key),
  };
}
