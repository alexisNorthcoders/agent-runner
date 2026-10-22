import { errorText } from './narrow.ts';
import type { Store } from './redisStore.ts';

/**
 * The runner's one internal "state changed" notification. Anything that changes what the status
 * views would show calls `notify`, and the office feed (src/officeFeed.js) subscribes so it pushes
 * a new snapshot on change instead of polling. Notifications carry only a reason, for logs and
 * tests: subscribers re-read the state themselves, so a burst of changes can be coalesced.
 *
 * Sources: every Redis state write (lock, queue, pauses, cron state) through `notifyingStore`, the
 * runner's in-memory changes (agent progress, phase, a run starting and ending), and writes by
 * other processes (the `agent:pause` CLI, safe-restart), which publish them on a Redis channel
 * (`STATE_CHANNEL` in src/redisStore.ts) the runner subscribes to.
 */
export type NotifyChange = (reason: string) => void;

export function createStateChanges({ logger = console }: { logger?: Pick<Console, 'warn'> } = {}) {
  const subscribers: Set<NotifyChange> = new Set();
  return {
    notify(reason: string) {
      for (const fn of subscribers) {
        try {
          fn(reason);
        } catch (err) {
          logger.warn(`state change subscriber failed: ${errorText(err)}`);
        }
      }
    },
    /** @returns unsubscribe */
    subscribe(fn: NotifyChange): () => void {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

/**
 * `store` with `notify(key)` after each write that changed something. Reads and the outbox stream
 * (messages, not state) stay quiet, and so do conditional writes that didn't apply. A write
 * settles once `notify` has (so a CLI's publish goes out before it exits).
 */
export function notifyingStore(store: Store, notify: (key: string) => void | Promise<void>): Store {
  const wrap =
    <A extends unknown[], R>(write: (key: string, ...rest: A) => Promise<R>, changed: (result: R) => boolean = () => true) =>
    async (key: string, ...rest: A): Promise<R> => {
      const r = await write(key, ...rest);
      if (changed(r)) await notify(key);
      return r;
    };
  const applied = (ok: boolean) => ok;
  return {
    ...store,
    set: wrap(store.set),
    setWithTtl: wrap(store.setWithTtl),
    setIfAbsent: wrap(store.setIfAbsent, applied),
    replaceIfPresent: wrap(store.replaceIfPresent, applied),
    deleteIfField: wrap(store.deleteIfField, applied),
    del: wrap(store.del),
    hashSet: wrap(store.hashSet),
    hashDelete: wrap(store.hashDelete),
    listPushBack: wrap(store.listPushBack),
    listPushFront: wrap(store.listPushFront),
    listPopFront: wrap(store.listPopFront, (v) => v != null),
    listReplaceAt: wrap(store.listReplaceAt, applied),
  };
}
