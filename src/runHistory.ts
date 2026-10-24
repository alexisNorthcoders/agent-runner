/**
 * Append-only history of finished runs (`runs.jsonl`, one JSON object per line), for status
 * commands and cost tracking. Live state lives in the Redis lock and `active/` files instead.
 */

import { appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { isRecord, parseJsonObject } from './narrow.ts';

export type HistoryEntry = {
  runId: string;
  kind?: string;
  label?: string;
  parentRunId?: string;
  startedAt?: string;
  endedAt: string;
  durationMs?: number;
  outcome: string;
  logPath?: string;
  model?: string | null;
  turns?: number;
  costUsd?: number | null;
  tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number };
  [key: string]: unknown;
};

type Tokens = NonNullable<HistoryEntry['tokens']>;

const STRING_FIELDS = ['kind', 'label', 'parentRunId', 'startedAt', 'logPath'] as const;
const NUMBER_FIELDS = ['durationMs', 'turns'] as const;

function parseTokens(v: unknown): Tokens | null {
  if (!isRecord(v)) return null;
  const { input, output, cacheRead, cacheCreate } = v;
  if (typeof input !== 'number' || typeof output !== 'number' || typeof cacheRead !== 'number' || typeof cacheCreate !== 'number') return null;
  return { input, output, cacheRead, cacheCreate };
}

/**
 * A history row, or null for one the runner didn't write (it always writes `runId`, `endedAt` and
 * `outcome`). A declared field of the wrong type is left out; undeclared fields are kept as they are.
 */
export function parseHistoryEntry(o: Record<string, unknown>): HistoryEntry | null {
  const { runId, endedAt, outcome } = o;
  if (typeof runId !== 'string' || typeof endedAt !== 'string' || typeof outcome !== 'string') return null;
  // a copy keeps the row's key order, which `agent:history --json` prints
  const entry: HistoryEntry = { ...o, runId, endedAt, outcome };
  for (const k of STRING_FIELDS) if (k in o && typeof o[k] !== 'string') delete entry[k];
  for (const k of NUMBER_FIELDS) if (k in o && typeof o[k] !== 'number') delete entry[k];
  if ('model' in o && typeof o.model !== 'string' && o.model !== null) delete entry.model;
  if ('costUsd' in o && typeof o.costUsd !== 'number' && o.costUsd !== null) delete entry.costUsd;
  if ('tokens' in o) {
    const tokens = parseTokens(o.tokens);
    if (tokens) entry.tokens = tokens;
    else delete entry.tokens;
  }
  return entry;
}

export function createRunHistory({ dir }: { dir: string }) {
  const path = join(dir, 'runs.jsonl');
  return {
    async append(entry: object) {
      await mkdir(dir, { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    },

    /**
     * Finished runs, newest first. Torn or corrupt lines are skipped.
     */
    async read({ limit = Infinity, sinceMs }: { limit?: number; sinceMs?: number } = {}): Promise<HistoryEntry[]> {
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return [];
      }
      const rows: HistoryEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        // only the runner appends, so a line that doesn't parse as a row is torn
        const obj = parseJsonObject(line);
        const row = obj && parseHistoryEntry(obj);
        if (row) rows.push(row);
      }
      rows.reverse();
      const recent = sinceMs == null ? rows : rows.filter((r) => Date.parse(r.endedAt) >= sinceMs);
      return recent.slice(0, limit);
    },
  };
}
