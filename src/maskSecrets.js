/**
 * Best-effort masking of obvious secrets in a log line before it leaves the runner (the office
 * feed's log tail). It catches the common shapes, not every secret: GitHub tokens, `sk-` API keys,
 * bearer tokens, and the value of `…_KEY=` / `_TOKEN=` / `_SECRET=` / `_PASSWORD=` assignments
 * (bare, quoted, or with JSON-escaped quotes as in the agent's stream-json log) and of such keys in
 * JSON.
 */

const MASK = '***';

/** A secret's name: ends in `_KEY`, `_TOKEN`, `_SECRET` or `_PASSWORD`, any case. */
const NAME = '[A-Za-z0-9_]*_(?:key|token|secret|password)';

/** @type {[RegExp, string | ((...m: string[]) => string)][]} */
const RULES = [
  [/(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/(?<![A-Za-z0-9])(gh[pousr]_)[A-Za-z0-9]{20,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  // a short token needs a digit, so "the bearer of bad news" stays
  [/\b(bearer\s+)(?:(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{20,})/gi, `$1${MASK}`],
  // `NAME=value` / `NAME = value`; a bare value may hold JSON-escaped backslashes (`\\`)
  [
    new RegExp(`\\b(${NAME})(=|\\s+=\\s+)(?:(\\\\")(?:(?!\\\\").)*\\\\"|(")[^"]*"|(')[^']*'|(?:[^\\s"'\\\\=]|\\\\\\\\)(?:[^\\s"'\\\\]|\\\\\\\\)*)`, 'gi'),
    (_, name, eq, escaped, double, single) => {
      const q = escaped || double || single || '';
      return `${name}${eq}${q}${MASK}${q}`;
    },
  ],
  // `"NAME": "value"` in JSON
  [new RegExp(`("${NAME}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), `$1"${MASK}"`],
];

/** @param {string} line */
export function maskSecrets(line) {
  let out = line;
  for (const [re, to] of RULES) out = out.replace(re, /** @type {any} */ (to));
  return out;
}
