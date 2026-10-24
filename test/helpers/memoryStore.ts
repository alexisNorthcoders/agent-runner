import { parseJsonObject } from '../../src/narrow.ts';
import type { Store } from '../../src/redisStore.ts';

/**
 * In-memory fake of `Store` (src/redisStore.ts). TTLs are ignored; `test/store.contract.test.ts`
 * keeps its behavior in step with the real Redis store.
 */
export function createMemoryStore(): Store & { kv: Map<string, string>; hashes: Map<string, Map<string, string>>; streams: Map<string, Array<{ id: string; fields: Record<string, string> }>>; failNext: (err: Error) => void } {
  const kv: Map<string, string> = new Map();
  const hashes: Map<string, Map<string, string>> = new Map();
  const streams: Map<string, Array<{ id: string; fields: Record<string, string> }>> = new Map();
  const lists: Map<string, string[]> = new Map();
  let seq = 0;
  let lastMs = 0;
  let pendingError: Error | null = null;

  const check = () => {
    if (pendingError) {
      const e = pendingError;
      pendingError = null;
      throw e;
    }
  };

  const idMs = (id: string) => Number(id.split('-')[0]);

  return {
    kv,
    hashes,
    streams,
    /** Make the next store call reject (simulates a Redis outage). */
    failNext(err) {
      pendingError = err;
    },
    async get(key) {
      check();
      return kv.get(key) ?? null;
    },
    async set(key, value) {
      check();
      kv.set(key, value);
    },
    async setWithTtl(key, value) {
      check();
      kv.set(key, value);
    },
    async setIfAbsent(key, value) {
      check();
      if (kv.has(key)) return false;
      kv.set(key, value);
      return true;
    },
    async replaceIfPresent(key, value) {
      check();
      if (!kv.has(key)) return false;
      kv.set(key, value);
      return true;
    },
    async deleteIfField(key, field, expected) {
      check();
      const raw = kv.get(key);
      if (raw === undefined || parseJsonObject(raw)?.[field] !== expected) return false;
      kv.delete(key);
      return true;
    },
    async del(key) {
      check();
      kv.delete(key);
      hashes.delete(key);
      lists.delete(key);
    },
    async hashGetAll(key) {
      check();
      return Object.fromEntries(hashes.get(key) ?? []);
    },
    async hashSet(key, field, value) {
      check();
      if (!hashes.has(key)) hashes.set(key, new Map());
      hashes.get(key)?.set(field, value);
    },
    async hashDelete(key, field) {
      check();
      const h = hashes.get(key);
      h?.delete(field);
      if (h && !h.size) hashes.delete(key);
    },
    async appendToStream(key, fields, { minIdMs }) {
      check();
      const ms = Math.max(Date.now(), lastMs);
      seq = ms === lastMs ? seq + 1 : 0;
      lastMs = ms;
      const id = `${ms}-${seq}`;
      const entries = (streams.get(key) ?? []).filter((e) => idMs(e.id) >= minIdMs);
      entries.push({ id, fields: { ...fields } });
      streams.set(key, entries);
      return id;
    },
    async listPushBack(key, value) {
      check();
      const l = lists.get(key) ?? [];
      l.push(value);
      lists.set(key, l);
      return l.length;
    },
    async listPushFront(key, value) {
      check();
      const l = lists.get(key) ?? [];
      l.unshift(value);
      lists.set(key, l);
      return l.length;
    },
    async listPopFront(key) {
      check();
      const l = lists.get(key);
      const v = l?.shift() ?? null;
      if (l && !l.length) lists.delete(key);
      return v;
    },
    async listAll(key) {
      check();
      return [...(lists.get(key) ?? [])];
    },
    async listReplaceAt(key, index, expected, value) {
      check();
      const l = lists.get(key);
      if (!l || l[index] !== expected) return false;
      l[index] = value;
      return true;
    },
    async listLength(key) {
      check();
      return lists.get(key)?.length ?? 0;
    },
  };
}
