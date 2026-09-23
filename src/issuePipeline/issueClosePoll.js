/**
 * Poll until `fetchState()` reports CLOSED or wall-clock budget is exhausted.
 * Never throws from poll failures; surfaces last error when the final check fails.
 *
 * @param {{
 *   maxWaitMs: number,
 *   pollMs: number,
 *   fetchState: () => Promise<{ ok: boolean, state?: string, error?: string }>,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   onPollError?: (detail: { polls: number, error: string }) => void,
 * }} opts
 */
export async function pollGithubIssueClosedOrTimeout(opts) {
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? opts.maxWaitMs : 0;
  const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : 0;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const onPollError = opts.onPollError;

  const start = now();
  let polls = 0;
  let lastError = '';

  while (now() - start < maxWaitMs) {
    polls++;
    const r = await opts.fetchState();
    if (!r.ok) {
      lastError = r.error || '';
      onPollError?.({ polls, error: lastError });
    } else if (r.state === 'CLOSED') {
      return {
        closed: true,
        timedOut: false,
        waitedMs: now() - start,
        polls,
        lastState: r.state,
      };
    }
    await sleep(pollMs);
  }

  const final = await opts.fetchState();
  const lastState = final.ok ? String(final.state || '').trim().toUpperCase() : '';
  if (!final.ok) lastError = final.error || lastError;
  const closed = lastState === 'CLOSED';
  return {
    closed,
    timedOut: !closed,
    waitedMs: now() - start,
    polls,
    lastState,
    lastError: final.ok ? '' : lastError,
  };
}
