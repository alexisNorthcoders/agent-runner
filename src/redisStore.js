import { createClient } from 'redis';

/**
 * The narrow slice of Redis the runner uses. The lock, pause flag and outbox depend on this
 * interface, not on the client, so tests swap in `test/helpers/memoryStore.js`.
 *
 * @typedef {{
 *   get: (key: string) => Promise<string | null>,
 *   setIfAbsent: (key: string, value: string, ttlSeconds: number) => Promise<boolean>,
 *   replaceIfPresent: (key: string, value: string) => Promise<boolean>,
 *   deleteIfField: (key: string, field: string, expected: string) => Promise<boolean>,
 *   del: (key: string) => Promise<void>,
 *   appendToStream: (key: string, fields: Record<string, string>, opts: { minIdMs: number }) => Promise<string>,
 * }} Store
 */

/** Delete the key only if its JSON value has `field == expected`, atomically. */
const DELETE_IF_FIELD = `
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local ok, obj = pcall(cjson.decode, v)
if ok and type(obj) == 'table' and obj[ARGV[1]] == ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * @param {import('redis').RedisClientType<any, any, any>} client
 * @returns {Store}
 */
export function createRedisStore(client) {
  return {
    get: (key) => client.get(key),
    async setIfAbsent(key, value, ttlSeconds) {
      return (await client.set(key, value, { NX: true, EX: ttlSeconds })) === 'OK';
    },
    async replaceIfPresent(key, value) {
      return (await client.set(key, value, { XX: true, KEEPTTL: true })) === 'OK';
    },
    async deleteIfField(key, field, expected) {
      const n = await client.eval(DELETE_IF_FIELD, { keys: [key], arguments: [field, expected] });
      return n === 1;
    },
    async del(key) {
      await client.del(key);
    },
    appendToStream(key, fields, { minIdMs }) {
      return client.xAdd(key, '*', fields, {
        TRIM: { strategy: 'MINID', strategyModifier: '~', threshold: minIdMs },
      });
    },
  };
}

/**
 * Connected client for the service and CLIs. Errors are logged, and node-redis keeps reconnecting.
 * @param {{ url?: string, logger?: Pick<Console, 'error'> }} [opts]
 */
export async function connectRedis({ url = process.env.REDIS_URL || 'redis://127.0.0.1:6379', logger = console } = {}) {
  const client = createClient({ url });
  client.on('error', (err) => logger.error('agent-runner redis:', err.message));
  await client.connect();
  return client;
}
