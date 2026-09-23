import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * `cron-state.json`: the cron issue tracer's last tick, for `claude:status` and the terminal CLIs.
 * The cron (still to be ported) writes it after each tick. `pid` is the process running the cron,
 * so readers can tell a dead cron from an idle one, and `intervalMs` lets them predict the next tick.
 *
 * @typedef {{
 *   kind: 'busy' | 'no_eligible' | 'ran' | 'error' | string,
 *   repo?: string,
 *   issue?: number,
 *   result?: string,
 *   note?: string,
 * }} CronTickOutcome
 *
 * @typedef {{
 *   pid: number,
 *   intervalMs: number,
 *   lastTickStartedAt: string | null,
 *   lastTickEndedAt: string | null,
 *   outcome: CronTickOutcome | null,
 * }} CronState
 */

const FILE = 'cron-state.json';

/** @param {{ dir: string }} p @returns {Promise<CronState | null>} */
export async function readCronState({ dir }) {
  try {
    return JSON.parse(await readFile(join(dir, FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {{ dir: string, outcome: CronTickOutcome, intervalMs: number, startedAt: number, now?: () => number }} p
 */
export async function writeCronTick({ dir, outcome, intervalMs, startedAt, now = Date.now }) {
  /** @type {CronState} */
  const state = {
    pid: process.pid,
    intervalMs,
    lastTickStartedAt: new Date(startedAt).toISOString(),
    lastTickEndedAt: new Date(now()).toISOString(),
    outcome,
  };
  await mkdir(dir, { recursive: true });
  const path = join(dir, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  await rename(tmp, path);
}
