import { isRecord, parseJsonObject, recordOrEmpty } from './narrow.ts';
import { isSpecRunAction } from './commands.ts';
import type { SpecRunAction } from './commands.ts';
import { parseJob } from './scheduledJobs.ts';
import type { ScheduledJob } from './scheduledJobs.ts';
import type { Store } from './redisStore.ts';

/**
 * The Parent run a `claude:more` request continues, as picked when it was submitted (so a run that
 * finishes while it waits doesn't change it). `pending`: the Parent was still running when the
 * request arrived, so `sessionId` and `endedAt` are read from its history row when this starts.
 */
export type ContinuationParent =
  | {
      runId: string;
      kind: 'freeform' | 'joplin';
      label: string;
      sessionId: string;
      cwd: string;
      endedAt: string;
      outcome?: string;
      model?: string;
      inferredWorkspace?: string;
    }
  | {
      runId: string;
      kind: 'freeform' | 'joplin';
      label: string;
      cwd: string;
      pending: true;
    };

/**
 * FIFO of run requests that arrived while the agent was busy (or the runner paused), in Redis so it
 * survives a restart. The runner starts them one at a time, oldest first, as each run finishes. A
 * manual request the usage limit stopped before it started goes back to the front.
 */
export type QueuedRun = {
  id: string;
  cmd: { kind: 'freeform'; prompt: string; model?: string } |
  { kind: 'joplin'; noteQuery: string; model?: string } |
  { kind: 'more'; instructions: string; parent: ContinuationParent; model?: string } |
  { kind: 'issue'; issueNumber: number; alias: string | null; extraInstructions: string } |
  { kind: 'spec'; action: SpecRunAction; issueNumber: number; alias: string | null; notes: string } |
  { kind: 'job'; job: ScheduledJob };
  replyTo: string;
  label: string;
  queuedAt: string;
};

export const QUEUE_KEY = 'agent-runner:queue';
export const MAX_QUEUE_LENGTH = 20;

/** A report's line for a request the usage limit stopped before it started, re-queued at the front. */
export const REQUEUED_NOTE = 'It is back at the head of the queue, and runs again once the limit resets.';

type QueuedCmd = QueuedRun['cmd'];

const isString = (v: unknown): v is string => typeof v === 'string';
/** `{ model }` when `v` is a string, else nothing. */
const modelField = (v: unknown) => (isString(v) ? { model: v } : {});

function parseParent(p: unknown): ContinuationParent | null {
  if (!isRecord(p)) return null;
  const { runId, kind, label, cwd } = p;
  if (!isString(runId) || (kind !== 'freeform' && kind !== 'joplin') || !isString(label) || !isString(cwd)) return null;
  if (p.pending === true) return { runId, kind, label, cwd, pending: true };
  if (!isString(p.sessionId) || !isString(p.endedAt)) return null;
  return {
    runId,
    kind,
    label,
    sessionId: p.sessionId,
    cwd,
    endedAt: p.endedAt,
    ...(isString(p.outcome) ? { outcome: p.outcome } : {}),
    ...modelField(p.model),
    ...(isString(p.inferredWorkspace) ? { inferredWorkspace: p.inferredWorkspace } : {}),
  };
}

function parseCmd(c: unknown): QueuedCmd | null {
  if (!isRecord(c)) return null;
  switch (c.kind) {
    case 'freeform':
      return isString(c.prompt) ? { kind: 'freeform', prompt: c.prompt, ...modelField(c.model) } : null;
    case 'joplin':
      return isString(c.noteQuery) ? { kind: 'joplin', noteQuery: c.noteQuery, ...modelField(c.model) } : null;
    case 'more': {
      const parent = parseParent(c.parent);
      return parent && isString(c.instructions) ? { kind: 'more', instructions: c.instructions, parent, ...modelField(c.model) } : null;
    }
    case 'issue':
      return typeof c.issueNumber === 'number' && (c.alias === null || isString(c.alias)) && isString(c.extraInstructions)
        ? { kind: 'issue', issueNumber: c.issueNumber, alias: c.alias, extraInstructions: c.extraInstructions }
        : null;
    case 'spec':
      return isString(c.action) && isSpecRunAction(c.action) && typeof c.issueNumber === 'number' && (c.alias === null || isString(c.alias)) && isString(c.notes)
        ? { kind: 'spec', action: c.action, issueNumber: c.issueNumber, alias: c.alias, notes: c.notes }
        : null;
    case 'job': {
      const job = parseJob(c.job);
      return typeof job === 'string' ? null : { kind: 'job', job };
    }
    default:
      return null;
  }
}

/** Only `push` and `unshift` write the queue, so an item that doesn't parse is torn or foreign, and is skipped. */
function parse(raw: string): QueuedRun | null {
  const item = parseJsonObject(raw);
  const cmd = parseCmd(item?.cmd);
  if (!item || !cmd || !isString(item.id) || !isString(item.replyTo) || !isString(item.label) || !isString(item.queuedAt)) return null;
  return { id: item.id, cmd, replyTo: item.replyTo, label: item.label, queuedAt: item.queuedAt };
}

/** `id <id>, kind <kind>` of a queued item that didn't parse, as far as it can be read. */
function describeTorn(raw: string) {
  const item = parseJsonObject(raw);
  const kind = recordOrEmpty(item?.cmd).kind;
  return `id ${isString(item?.id) ? item.id : '?'}, kind ${isString(kind) ? kind : '?'}`;
}

export function createRunQueue({
  store,
  key = QUEUE_KEY,
  maxLength = MAX_QUEUE_LENGTH,
  logger = console,
}: {
  store: Store;
  key?: string;
  maxLength?: number;
  logger?: Pick<Console, 'warn'>;
}) {
  return {
    maxLength,
    /**
     * Append to the back. Returns the item's 1-based position, or null when the queue is full.
     * The length check and push aren't atomic, which is fine because only the runner process pushes.
     */
    async push(item: QueuedRun): Promise<number | null> {
      if ((await store.listLength(key)) >= maxLength) return null;
      return store.listPushBack(key, JSON.stringify(item));
    },
    /** Take the oldest item, skipping unreadable ones. */
    async shift(): Promise<QueuedRun | null> {
      for (;;) {
        const raw = await store.listPopFront(key);
        if (raw == null) return null;
        const item = parse(raw);
        if (item) return item;
        logger.warn(`queue: dropped an unreadable item (${describeTorn(raw)})`);
      }
    },
    /**
     * Put an item at the front: it was taken but couldn't start, or the usage limit stopped its run
     * before it started. No length check, as it had a place already.
     */
    async unshift(item: QueuedRun) {
      await store.listPushFront(key, JSON.stringify(item));
    },
    /**
     * Rewrite a waiting item in place, keeping its position. The change is dropped (null) when the
     * item is no longer waiting, e.g. it was just taken to start.
     */
    async update(id: string, change: (item: QueuedRun) => QueuedRun): Promise<{ item: QueuedRun; position: number } | null> {
      const raws = await store.listAll(key);
      for (let i = 0; i < raws.length; i++) {
        const old = parse(raws[i]);
        if (old?.id !== id) continue;
        const item = change(old);
        return (await store.listReplaceAt(key, i, raws[i], JSON.stringify(item))) ? { item, position: i + 1 } : null;
      }
      return null;
    },
    /** The queued items, front first. */
    async list(): Promise<QueuedRun[]> {
      return (await store.listAll(key)).map(parse).filter((x) => x !== null);
    },
    length: () => store.listLength(key),
    clear: () => store.del(key),
  };
}
