/**
 * In-memory fake of `Store` (src/redisStore.js). TTLs are ignored; `test/store.contract.test.js`
 * keeps its behaviour in step with the real Redis store.
 * @returns {import('../../src/redisStore.js').Store & { kv: Map<string, string>, hashes: Map<string, Map<string, string>>, streams: Map<string, Array<{ id: string, fields: Record<string, string> }>>, failNext: (err: Error) => void }}
 */
export function createMemoryStore() {
  const kv = new Map();
  /** @type {Map<string, Map<string, string>>} */
  const hashes = new Map();
  /** @type {Map<string, Array<{ id: string, fields: Record<string, string> }>>} */
  const streams = new Map();
  let seq = 0;
  let lastMs = 0;
  /** @type {Error | null} */
  let pendingError = null;

  const check = () => {
    if (pendingError) {
      const e = pendingError;
      pendingError = null;
      throw e;
    }
  };

  const idMs = (id) => Number(String(id).split('-')[0]);

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
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
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
      if (!kv.has(key)) return false;
      let parsed;
      try {
        parsed = JSON.parse(kv.get(key));
      } catch {
        return false;
      }
      if (parsed?.[field] !== expected) return false;
      kv.delete(key);
      return true;
    },
    async del(key) {
      check();
      kv.delete(key);
      hashes.delete(key);
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
  };
}
