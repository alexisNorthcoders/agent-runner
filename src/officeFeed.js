/**
 * The office feed: a read-only Server-Sent Events stream of office snapshots
 * (src/officeSnapshot.js) for the dashboard page. Each client gets a full snapshot on connect, then
 * a new one after each state change (src/stateChanges.js). Changes are coalesced: the first one
 * schedules a push `coalesceMs` later, and pushes are at least `minIntervalMs` apart, so a stream
 * of agent progress costs one snapshot build per interval for every client together, and a change
 * shows within about `minIntervalMs`.
 *
 * A slow heartbeat resends the snapshot. It keeps idle connections open through proxies, and picks
 * up what changed in another process (a pause from `npm run agent:pause`, safe-restart's pause
 * flag), which this process isn't told about.
 *
 * Events are `event: snapshot` with the snapshot as JSON on one `data:` line.
 */

export const FEED_COALESCE_MS = 250;
export const FEED_MIN_INTERVAL_MS = 1000;
export const FEED_HEARTBEAT_MS = 30_000;
export const FEED_MAX_CLIENTS = 20;

/**
 * @param {{
 *   snapshot: () => Promise<unknown>,
 *   subscribe: (fn: import('./stateChanges.js').NotifyChange) => () => void,
 *   coalesceMs?: number,
 *   minIntervalMs?: number,
 *   heartbeatMs?: number,
 *   maxClients?: number,
 *   logger?: Pick<Console, 'warn'>,
 * }} p
 */
export function createOfficeFeed({
  snapshot,
  subscribe,
  coalesceMs = FEED_COALESCE_MS,
  minIntervalMs = FEED_MIN_INTERVAL_MS,
  heartbeatMs = FEED_HEARTBEAT_MS,
  maxClients = FEED_MAX_CLIENTS,
  logger = console,
}) {
  /** Each client, with the number of the newest snapshot it has been sent. @type {Map<import('http').ServerResponse, number>} */
  const clients = new Map();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let building = false;
  let dirty = false;
  let lastPush = 0;
  /** Snapshots are numbered in the order their builds start, so a client never gets an older one after a newer one. */
  let builds = 0;

  /** @param {unknown} snap */
  const event = (snap) => `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;

  /** @returns {Promise<{ seq: number, text: string } | null>} */
  async function build() {
    const seq = ++builds;
    try {
      return { seq, text: event(await snapshot()) };
    } catch (err) {
      logger.warn(`office feed: snapshot failed: ${err?.message || err}`);
      return null;
    }
  }

  /** @param {import('http').ServerResponse} res @param {{ seq: number, text: string } | null} snap */
  function send(res, snap) {
    const sent = clients.get(res);
    if (!snap || sent == null || sent >= snap.seq) return;
    clients.set(res, snap.seq);
    res.write(snap.text);
  }

  async function push() {
    timer = null;
    if (!clients.size) return;
    building = true;
    dirty = false;
    const snap = await build();
    building = false;
    lastPush = Date.now();
    for (const res of clients.keys()) send(res, snap);
    if (dirty) schedule();
  }

  function schedule() {
    if (!clients.size) return;
    if (timer || building) {
      dirty = true;
      return;
    }
    const delay = Math.max(coalesceMs, lastPush + minIntervalMs - Date.now());
    timer = setTimeout(() => void push(), delay);
  }

  const unsubscribe = subscribe(() => schedule());
  const heartbeat = setInterval(schedule, heartbeatMs);
  heartbeat.unref();

  return {
    /**
     * Serve the stream on `res` until the client goes away.
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     */
    async attach(req, res) {
      if (clients.size >= maxClients) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ reply: 'Too many office feed clients' }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx: don't buffer the stream
        'x-accel-buffering': 'no',
      });
      // the browser's EventSource waits this long before reconnecting
      res.write('retry: 3000\n\n');
      clients.set(res, 0);
      res.on('close', () => clients.delete(res));
      // its own first snapshot, unless a push got a newer one to it first
      send(res, await build());
    },

    /** How many clients are connected. */
    clients: () => clients.size,

    /** End every stream and stop listening for changes. */
    close() {
      unsubscribe();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      timer = null;
      for (const res of clients.keys()) res.end();
      clients.clear();
    },
  };
}
