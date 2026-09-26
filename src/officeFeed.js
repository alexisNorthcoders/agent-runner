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
  /** @type {Set<import('http').ServerResponse>} */
  const clients = new Set();
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let building = false;
  let dirty = false;
  let lastPush = 0;
  /** Counts changes, so a client that connected mid-change gets the push it missed. */
  let changes = 0;
  /** Clients still waiting for their first snapshot. */
  let joining = 0;

  /** @param {unknown} snap */
  const event = (snap) => `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;

  async function build() {
    try {
      return await snapshot();
    } catch (err) {
      logger.warn(`office feed: snapshot failed: ${err?.message || err}`);
      return null;
    }
  }

  async function push() {
    timer = null;
    if (!clients.size) return;
    building = true;
    dirty = false;
    const snap = await build();
    building = false;
    lastPush = Date.now();
    if (snap != null) {
      const text = event(snap);
      for (const res of clients) res.write(text);
    }
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

  const unsubscribe = subscribe(() => {
    changes++;
    schedule();
  });
  const heartbeat = setInterval(schedule, heartbeatMs);
  heartbeat.unref();

  return {
    /**
     * Serve the stream on `res` until the client goes away.
     * @param {import('http').IncomingMessage} req
     * @param {import('http').ServerResponse} res
     */
    async attach(req, res) {
      if (clients.size + joining >= maxClients) {
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
      // joins the broadcast only after its first snapshot, so it never gets an older one after a newer one
      let gone = false;
      res.on('close', () => {
        gone = true;
        clients.delete(res);
      });
      const seen = changes;
      joining++;
      const snap = await build();
      joining--;
      if (gone) return;
      if (snap != null) res.write(event(snap));
      clients.add(res);
      if (changes !== seen) schedule();
    },

    /** How many clients are connected. */
    clients: () => clients.size,

    /** End every stream and stop listening for changes. */
    close() {
      unsubscribe();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      timer = null;
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
