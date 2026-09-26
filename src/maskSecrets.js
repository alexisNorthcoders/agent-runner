/**
 * Best-effort masking of obvious secrets in a log line before it leaves the runner (the office
 * feed's log tail). It catches the common shapes, not every secret: GitHub tokens, `sk-` API keys,
 * bearer tokens, and the value of `…_KEY=` / `_TOKEN=` / `_SECRET=` / `_PASSWORD=` assignments
 * (bare, quoted, or with JSON-escaped quotes as in the agent's stream-json log).
 */

const MASK = '***';

/** @type {[RegExp, string | ((...m: string[]) => string)][]} */
const RULES = [
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, `github_pat_${MASK}`],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, `$1${MASK}`],
  [/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}/g, `sk-${MASK}`],
  // the token must have a digit, so "the bearer of bad news" stays
  [/\b(bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [
    /\b([A-Za-z0-9_]*_(?:key|token|secret|password))=(?:(\\")(?:(?!\\").)*\\"|(")[^"]*"|(')[^']*'|[^\s"'\\=][^\s"'\\]*)/gi,
    (_, name, escaped, double, single) => {
      const q = escaped || double || single || '';
      return `${name}=${q}${MASK}${q}`;
    },
  ],
];

/** @param {string} line */
export function maskSecrets(line) {
  let out = line;
  for (const [re, to] of RULES) out = out.replace(re, /** @type {any} */ (to));
  return out;
}
