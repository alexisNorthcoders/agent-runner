import { describeRun } from './runLock.ts';
import { errorText } from './narrow.ts';
import type { RunRecord, createRunLock } from './runLock.ts';
import type { PauseRecord, createPauseFlag } from './pauseFlag.ts';

const CLEAR_ATTEMPTS = 3;

/**
 * The only sanctioned way to restart agent-runner (`npm run safe-restart`, also `claude:restart`):
 * refuse if busy → set the pause flag → restart the PM2 app → wait for `/status` → clear the pause.
 * The pause stops a new run from starting in the gap. The lock is checked again after pausing, so
 * a run that starts between the first check and the pause still makes the restart refuse.
 */

export function decideSafeRestart({ activeRun, pause }: { activeRun: RunRecord | null; pause: PauseRecord | null }): { ok: true } | { ok: false; reason: string } {
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

export async function runSafeRestart({ lock, pause, restartProcess, waitForReady }: {
    lock: Pick<ReturnType<typeof createRunLock>, 'current'>;
    pause: Pick<ReturnType<typeof createPauseFlag>, 'get' | 'set' | 'clear'>;
    restartProcess: () => Promise<void>;
    waitForReady: () => Promise<void>;
  }): Promise<{ ok: boolean; message: string }> {
  const refused = (reason: string) => ({ ok: false, message: `safe-restart refused: ${reason}` });

  const first = decideSafeRestart({ activeRun: await lock.current(), pause: await pause.get() });
  if ('reason' in first) return refused(first.reason);

  const token = await pause.set('safe-restart');
  if (!token) return refused('agent-runner was paused by someone else just now.');

  let result: { ok: boolean; message: string };
  try {
    const again = decideSafeRestart({ activeRun: await lock.current(), pause: null });
    if ('reason' in again) result = refused(again.reason);
    else {
      await restartProcess();
      await waitForReady();
      result = { ok: true, message: 'agent-runner restarted and is answering /status.' };
    }
  } catch (err) {
    result = { ok: false, message: `safe-restart failed: ${errorText(err)}` };
  }

  // Every path above ends here, so the pause never outlives this call unless Redis itself fails
  let clearErr: unknown;
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
    message: `${result.message} Could not clear the pause flag (${errorText(clearErr)}); it expires on its own.`,
  };
}
