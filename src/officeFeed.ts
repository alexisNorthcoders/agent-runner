/**
 * The office feed: a read-only Server-Sent Events stream of office snapshots
 * (src/officeSnapshot.ts) for the dashboard page. Each client gets a full snapshot on connect, then
 * a new one after each state change (src/stateChanges.ts). Changes are coalesced: the first one
 * schedules a push `coalesceMs` later, and pushes are at least `minIntervalMs` apart, so a stream
 * of agent progress costs one snapshot build per interval for every client together, and a change
 * shows within about `minIntervalMs`.
 *
 * A slow heartbeat resends the snapshot. It keeps idle connections open through proxies, and picks
 * up what changed in another process (a pause from `npm run agent:pause`, safe-restart's pause
 * flag), which this process isn't told about.
 *
 * With a `logTail` (src/logTail.ts), the feed also carries the active run's live log: the tail is
 * followed while anyone is connected, a client that connects mid-run gets its recent lines right
 * after its first snapshot, and new lines go to every client as they are read. The lines are
 * already masked by the tail, so nothing unmasked leaves the runner.
 *
 * Events are `event: snapshot` with the snapshot as JSON on one `data:` line, and `event: log`
 * with `{ runId, reset, lines }` (`reset`: a new run, so replace the pane's lines, else append).
 */

import { errorText } from './narrow.ts';
import type { NotifyChange } from './stateChanges.ts';
import type { createLogTail, LogLines } from './logTail.ts';
import type { ServerResponse, IncomingMessage } from 'http';

export const FEED_COALESCE_MS = 250;
export const FEED_MIN_INTERVAL_MS = 1000;
export const FEED_HEARTBEAT_MS = 30_000;
export const FEED_MAX_CLIENTS = 20;

export function createOfficeFeed({
  snapshot,
  subscribe,
  coalesceMs = FEED_COALESCE_MS,
  minIntervalMs = FEED_MIN_INTERVAL_MS,
  heartbeatMs = FEED_HEARTBEAT_MS,
  maxClients = FEED_MAX_CLIENTS,
  logTail,
  logger = console,
}: {
    snapshot: () => Promise<unknown>;
    subscribe: (fn: NotifyChange) => () => void;
    coalesceMs?: number;
    minIntervalMs?: number;
    heartbeatMs?: number;
    maxClients?: number;
    logTail?: Pick<ReturnType<typeof createLogTail>, 'start' | 'stop' | 'tail' | 'onLines'>;
    logger?: Pick<Console, 'warn'>;
  }) {
  /** Each client, with the number of the newest snapshot it has been sent. */
  const clients: Map<ServerResponse, number> = new Map();
  /** Clients that have had their log tail, so they get new lines. */
  const logClients: Set<ServerResponse> = new Set();
  let timer: NodeJS.Timeout | null = null;
  let building = false;
  let dirty = false;
  let lastPush = 0;
  /** Snapshots are numbered in the order their builds start, so a client never gets an older one after a newer one. */
  let builds = 0;

  const event = (snap: unknown) => `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
  const logEvent = (e: LogLines) => `event: log\ndata: ${JSON.stringify(e)}\n\n`;

  async function build(): Promise<{ seq: number; text: string } | null> {
    const seq = ++builds;
    try {
      return { seq, text: event(await snapshot()) };
    } catch (err) {
      logger.warn(`office feed: snapshot failed: ${errorText(err)}`);
      return null;
    }
  }

  function send(res: ServerResponse, snap: { seq: number; text: string } | null) {
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
  const unsubscribeLog =
    logTail?.onLines((e) => {
      const text = logEvent(e);
      for (const res of logClients) res.write(text);
    }) ?? (() => {});
  const heartbeat = setInterval(schedule, heartbeatMs);
  heartbeat.unref();

  return {
    /**
     * Serve the stream on `res` until the client goes away.
     */
    async attach(req: IncomingMessage, res: ServerResponse) {
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
      res.on('close', () => {
        clients.delete(res);
        logClients.delete(res);
        if (!clients.size) logTail?.stop();
      });
      // a no-op if already following; settles once the tail holds the active run's recent lines
      await logTail?.start();
      // its own first snapshot, unless a push got a newer one to it first
      send(res, await build());
      if (!logTail || !clients.has(res)) return;
      // the tail so far, then (from the same tick, so nothing is missed or repeated) new lines
      const { runId, lines } = logTail.tail();
      if (runId) res.write(logEvent({ runId, reset: true, lines }));
      logClients.add(res);
    },

    /** How many clients are connected. */
    clients: () => clients.size,

    /** End every stream and stop listening for changes. */
    close() {
      unsubscribe();
      unsubscribeLog();
      logTail?.stop();
      clearInterval(heartbeat);
      if (timer) clearTimeout(timer);
      timer = null;
      for (const res of clients.keys()) res.end();
      clients.clear();
      logClients.clear();
    },
  };
}
