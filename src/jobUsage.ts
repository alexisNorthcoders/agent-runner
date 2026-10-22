/**
 * A scheduled job's agent usage report: the job appends one JSON line per agent call to the file
 * named by `AGENT_RUNNER_USAGE_FILE`, and the runner adds the lines up into the job's history row.
 *
 * @typedef {{ model: string | null, turns: number, costUsd: number | null, tokens: { input: number, output: number, cacheRead: number, cacheCreate: number } }} JobUsage
 */

export const USAGE_FILE_ENV = 'AGENT_RUNNER_USAGE_FILE';

/** A missing, negative or non-numeric count is 0. @param {unknown} n */
const count = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

/**
 * Add up the usage lines. Malformed lines are skipped (and passed to `onSkip`). Null when no line is valid.
 * @param {string} text
 * @param {(line: string, why: string) => void} [onSkip]
 * @returns {JobUsage | null}
 */
export function sumJobUsage(text, onSkip = () => {}) {
  /** @type {JobUsage} */
  const sum = { model: null, turns: 0, costUsd: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 } };
  let valid = 0;
  let firstModel = null;
  let topCost = -1;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      onSkip(line, 'not valid JSON');
      continue;
    }
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      onSkip(line, 'not an object');
      continue;
    }
    valid++;
    const model = typeof o.model === 'string' && o.model ? o.model : null;
    firstModel ??= model;
    sum.turns += count(o.turns);
    const t = o.tokens && typeof o.tokens === 'object' ? o.tokens : {};
    for (const k of /** @type {const} */ (['input', 'output', 'cacheRead', 'cacheCreate'])) sum.tokens[k] += count(t[k]);
    if (typeof o.costUsd === 'number' && Number.isFinite(o.costUsd)) {
      sum.costUsd = (sum.costUsd ?? 0) + o.costUsd;
      if (model && o.costUsd > topCost) {
        topCost = o.costUsd;
        sum.model = model;
      }
    }
  }
  if (!valid) return null;
  sum.model ??= firstModel;
  return sum;
}
