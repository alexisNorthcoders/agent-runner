import { appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';
import { parseJsonObject } from './narrow.ts';

/**
 * Append-only history of finished runs (`runs.jsonl`, one JSON object per line), for status
 * commands and cost tracking. Live state lives in the Redis lock and `active/` files instead.
 */
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
        // only the runner appends, so a line with a runId is a row; anything else is torn
        const row = parseJsonObject(line);
        if (typeof row?.runId === 'string') rows.push(row as HistoryEntry);
      }
      rows.reverse();
      const recent = sinceMs == null ? rows : rows.filter((r) => Date.parse(r.endedAt) >= sinceMs);
      return recent.slice(0, limit);
    },
  };
}
