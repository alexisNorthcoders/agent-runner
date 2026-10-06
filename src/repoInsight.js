/**
 * Rotation for `repo_insight`: which workspace to visit next. Pure decision-making plus the
 * cursor's persistence; no GitHub calls or agent sessions.
 *
 * - `agent-runner:repo-insight:cursor` (string): the alias last visited.
 */

export const REPO_INSIGHT_CURSOR_KEY = 'agent-runner:repo-insight:cursor';

export const REPO_INSIGHT_PRIORITY = [
  'bot',
  'chess-trainer',
  'agent-runner',
  'reddit-bot',
  'snake-phaser',
  'snake-colyseus',
  'go-server',
  'platformer',
  'snake-lab',
  'reply-buddy',
  'home-manuals',
  'dots',
];

/**
 * The next idle workspace: walk forward from just after the cursor, wrapping around the end. A
 * cursor that isn't in the order (or is null) starts from the top. The cursor itself is the last
 * candidate, so a lone idle workspace is picked again.
 * @param {readonly string[]} order
 * @param {Readonly<Record<string, boolean>> | ReadonlyMap<string, boolean>} idle alias → idle
 * @param {string | null} cursor the alias last visited
 * @returns {string | null} null when no workspace is idle
 */
export function pickNextIdleWorkspace(order, idle, cursor) {
  const isIdle = (/** @type {string} */ alias) => (idle instanceof Map ? idle.get(alias) : /** @type {any} */ (idle)[alias]) === true;
  const start = cursor == null ? -1 : order.indexOf(cursor);
  for (let i = 1; i <= order.length; i++) {
    const alias = order[(start + i) % order.length];
    if (isIdle(alias)) return alias;
  }
  return null;
}

/** @param {{ store: import('./redisStore.js').Store }} p */
export function createRepoInsightCursor({ store }) {
  return {
    /** @returns {Promise<string | null>} the alias last visited */
    async read() {
      const v = await store.get(REPO_INSIGHT_CURSOR_KEY);
      return v ? v : null;
    },

    /** @param {string} alias */
    async write(alias) {
      if (typeof alias !== 'string' || !alias) throw new TypeError(`repo insight: invalid alias ${JSON.stringify(alias)}`);
      await store.set(REPO_INSIGHT_CURSOR_KEY, alias);
    },
  };
}
