import { createClient } from 'redis';

/**
 * The narrow slice of Redis the runner uses. The lock, pause flag, queue, outbox and cron state depend on this
 * interface, not on the client, so tests swap in `test/helpers/memoryStore.js`.
 *
 * @typedef {{
 *   get: (key: string) => Promise<string | null>,
 *   set: (key: string, value: string) => Promise<void>,
 *   setIfAbsent: (key: string, value: string, ttlSeconds: number) => Promise<boolean>,
 *   replaceIfPresent: (key: string, value: string) => Promise<boolean>,
 *   deleteIfField: (key: string, field: string, expected: string) => Promise<boolean>,
 *   del: (key: string) => Promise<void>,
 *   hashGetAll: (key: string) => Promise<Record<string, string>>,
 *   hashSet: (key: string, field: string, value: string) => Promise<void>,
 *   hashDelete: (key: string, field: string) => Promise<void>,
 *   appendToStream: (key: string, fields: Record<string, string>, opts: { minIdMs: number }) => Promise<string>,
 *   listPushBack: (key: string, value: string) => Promise<number>,
 *   listPushFront: (key: string, value: string) => Promise<number>,
 *   listPopFront: (key: string) => Promise<string | null>,
 *   listAll: (key: string) => Promise<string[]>,
 *   listLength: (key: string) => Promise<number>,
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
    async set(key, value) {
      await client.set(key, value);
    },
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
    async hashGetAll(key) {
      return { ...(await client.hGetAll(key)) };
    },
    async hashSet(key, field, value) {
      await client.hSet(key, field, value);
    },
    async hashDelete(key, field) {
      await client.hDel(key, field);
    },
    appendToStream(key, fields, { minIdMs }) {
      return client.xAdd(key, '*', fields, {
        TRIM: { strategy: 'MINID', strategyModifier: '~', threshold: minIdMs },
      });
    },
    listPushBack: (key, value) => client.rPush(key, value),
    listPushFront: (key, value) => client.lPush(key, value),
    listPopFront: (key) => client.lPop(key),
    listAll: (key) => client.lRange(key, 0, -1),
    listLength: (key) => client.lLen(key),
  };
}

/**
 * Connected client for the service and CLIs. Errors are logged, and node-redis keeps reconnecting.
 * @param {{ url: string, logger?: Pick<Console, 'error'> }} opts
 */
export async function connectRedis({ url, logger = console }) {
  const client = createClient({ url });
  client.on('error', (err) => logger.error('agent-runner redis:', err.message));
  await client.connect();
  return client;
}
