/**
 * The runner's one internal "state changed" notification. Anything that changes what the status
 * views would show calls `notify`, and the office feed (src/officeFeed.js) subscribes so it pushes
 * a new snapshot on change instead of polling. Notifications carry only a reason, for logs and
 * tests: subscribers re-read the state themselves, so a burst of changes can be coalesced.
 *
 * Sources: every Redis state write (lock, queue, pauses, cron state) through `notifyingStore`, and
 * the runner's in-memory changes (agent progress, phase, a finished run's history row).
 *
 * @typedef {(reason: string) => void} NotifyChange
 */

/**
 * @param {{ logger?: Pick<Console, 'warn'> }} [p]
 */
export function createStateChanges({ logger = console } = {}) {
  /** @type {Set<NotifyChange>} */
  const subscribers = new Set();
  return {
    /** @type {NotifyChange} */
    notify(reason) {
      for (const fn of subscribers) {
        try {
          fn(reason);
        } catch (err) {
          logger.warn(`state change subscriber failed: ${err?.message || err}`);
        }
      }
    },
    /** @param {NotifyChange} fn @returns {() => void} unsubscribe */
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/**
 * `store` with `notify(key)` after each write that changed something. Reads and the outbox stream
 * (messages, not state) stay quiet, and so do conditional writes that didn't apply.
 * @param {import('./redisStore.js').Store} store
 * @param {NotifyChange} notify
 * @returns {import('./redisStore.js').Store}
 */
export function notifyingStore(store, notify) {
  /**
   * @template {(key: string, ...rest: any[]) => Promise<any>} F
   * @param {F} write
   * @param {(result: Awaited<ReturnType<F>>) => boolean} [changed]
   * @returns {F}
   */
  const wrap = (write, changed = () => true) =>
    /** @type {F} */ (
      async (key, ...rest) => {
        const r = await write(key, ...rest);
        if (changed(r)) notify(key);
        return r;
      }
    );
  const applied = (/** @type {boolean} */ ok) => ok;
  return {
    ...store,
    set: wrap(store.set),
    setIfAbsent: wrap(store.setIfAbsent, applied),
    replaceIfPresent: wrap(store.replaceIfPresent, applied),
    deleteIfField: wrap(store.deleteIfField, applied),
    del: wrap(store.del),
    hashSet: wrap(store.hashSet),
    hashDelete: wrap(store.hashDelete),
    listPushBack: wrap(store.listPushBack),
    listPushFront: wrap(store.listPushFront),
    listPopFront: wrap(store.listPopFront, (v) => v != null),
  };
}
