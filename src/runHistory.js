import { appendFile, mkdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Append-only history of finished runs (`runs.jsonl`, one JSON object per line), for status
 * commands and cost tracking. Live state lives in the Redis lock and `active/` files instead.
 *
 * @typedef {{
 *   runId: string,
 *   kind?: string,
 *   label?: string,
 *   startedAt?: string,
 *   endedAt: string,
 *   durationMs?: number,
 *   outcome: string,
 *   logPath?: string,
 *   model?: string | null,
 *   turns?: number,
 *   costUsd?: number | null,
 *   tokens?: { input: number, output: number, cacheRead: number, cacheCreate: number },
 *   [key: string]: unknown,
 * }} HistoryEntry
 *
 * @param {{ dir: string }} p
 */
export function createRunHistory({ dir }) {
  const path = join(dir, 'runs.jsonl');
  return {
    /** @param {object} entry */
    async append(entry) {
      await mkdir(dir, { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    },

    /**
     * Finished runs, newest first. Torn or corrupt lines are skipped.
     * @param {{ limit?: number, sinceMs?: number }} [opts]
     * @returns {Promise<HistoryEntry[]>}
     */
    async read({ limit = Infinity, sinceMs } = {}) {
      let raw;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        return [];
      }
      /** @type {HistoryEntry[]} */
      const rows = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row && typeof row.runId === 'string') rows.push(row);
        } catch {
          /* torn line */
        }
      }
      rows.reverse();
      const recent = sinceMs == null ? rows : rows.filter((r) => Date.parse(r.endedAt) >= sinceMs);
      return recent.slice(0, limit);
    },
  };
}
