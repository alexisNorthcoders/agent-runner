import { appendFile, mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Append-only history of finished runs (`runs.jsonl`, one JSON object per line), for status
 * CLIs and cost tracking. Live state lives in the Redis lock and `GET /status` instead.
 * @param {{ dir: string }} p
 */
export function createRunHistory({ dir }) {
  return {
    /** @param {object} entry */
    async append(entry) {
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, 'runs.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}
