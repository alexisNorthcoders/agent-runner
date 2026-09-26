// The Now tab's live log: the lines the pane holds, updated from the office feed's `log` events
// (already masked by the runner). A new run replaces the lines, and so does an event for a run
// other than the one shown (e.g. after a reconnect). No DOM here, so it can be tested in Node.

/** The most lines the pane keeps; older ones scroll off. */
export const MAX_PANE_LINES = 1000;

/**
 * @param {{ runId: string | null, lines: string[] }} pane
 * @param {{ runId: string | null, reset: boolean, lines: string[] }} e
 * @param {number} [max]
 * @returns {{ runId: string | null, lines: string[] }}
 */
export function applyLogEvent(pane, e, max = MAX_PANE_LINES) {
  const lines = e.reset || e.runId !== pane.runId ? e.lines : [...pane.lines, ...e.lines];
  return { runId: e.runId, lines: lines.length > max ? lines.slice(-max) : lines };
}
