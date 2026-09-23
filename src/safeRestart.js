import { describeRun } from './runLock.js';

const CLEAR_ATTEMPTS = 3;

/**
 * The only sanctioned way to restart agent-runner (`npm run safe-restart`, also `claude:restart`):
 * refuse if busy → set the pause flag → restart the PM2 app → wait for `/status` → clear the pause.
 * The pause stops a new run from starting in the gap. The lock is checked again after pausing, so
 * a run that starts between the first check and the pause still makes the restart refuse.
 */

/**
 * @param {{ activeRun: import('./runLock.js').RunRecord | null, pause: import('./pauseFlag.js').PauseRecord | null }} s
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function decideSafeRestart({ activeRun, pause }) {
  if (activeRun) {
    return {
      ok: false,
      reason: `${describeRun(activeRun)} is active. Wait for it to finish or send claude:stop.`,
    };
  }
  if (pause) {
    return {
      ok: false,
      reason: `agent-runner is already paused (${pause.reason}${pause.pausedAt ? ` since ${pause.pausedAt}` : ''}). Another restart may be in progress.`,
    };
  }
  return { ok: true };
}

/**
 * @param {{
 *   lock: Pick<ReturnType<typeof import('./runLock.js').createRunLock>, 'current'>,
 *   pause: Pick<ReturnType<typeof import('./pauseFlag.js').createPauseFlag>, 'get' | 'set' | 'clear'>,
 *   restartProcess: () => Promise<void>,
 *   waitForReady: () => Promise<void>,
 * }} deps
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function runSafeRestart({ lock, pause, restartProcess, waitForReady }) {
  const refused = (reason) => ({ ok: false, message: `safe-restart refused: ${reason}` });

  const first = decideSafeRestart({ activeRun: await lock.current(), pause: await pause.get() });
  if ('reason' in first) return refused(first.reason);

  const token = await pause.set('safe-restart');
  if (!token) return refused('agent-runner was paused by someone else just now.');

  /** @type {{ ok: boolean, message: string }} */
  let result;
  try {
    const again = decideSafeRestart({ activeRun: await lock.current(), pause: null });
    if ('reason' in again) result = refused(again.reason);
    else {
      await restartProcess();
      await waitForReady();
      result = { ok: true, message: 'agent-runner restarted and is answering /status.' };
    }
  } catch (err) {
    result = { ok: false, message: `safe-restart failed: ${err?.message || String(err)}` };
  }

  // Every path above ends here, so the pause never outlives this call unless Redis itself fails
  let clearErr;
  for (let attempt = 0; attempt < CLEAR_ATTEMPTS; attempt++) {
    try {
      await pause.clear(token);
      return result;
    } catch (err) {
      clearErr = err;
    }
  }
  return {
    ok: false,
    message: `${result.message} Could not clear the pause flag (${clearErr?.message || String(clearErr)}); it expires on its own.`,
  };
}
