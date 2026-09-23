export const VERDICT_APPROVE = 'VERDICT: APPROVE';
export const VERDICT_REQUEST_CHANGES = 'VERDICT: REQUEST_CHANGES';

/**
 * After `gh pr create`, pick URL including recovery when GitHub says a PR already exists.
 * @param {{
 *   listedOk: boolean,
 *   listedUrl?: string,
 *   createOk: boolean,
 *   createUrl?: string,
 *   createError?: string,
 *   recoveredUrl?: string | null,
 * }} p
 * @returns {{ ok: boolean, url?: string, error?: string, prOutcome: 'listed' | 'created' | 'recovered' | null }}
 */
export function pickPrResultAfterGhFlow(p) {
  if (p.listedOk && p.listedUrl) {
    return { ok: true, url: p.listedUrl, prOutcome: 'listed' };
  }
  if (p.createOk && p.createUrl) {
    return { ok: true, url: p.createUrl, prOutcome: 'created' };
  }
  if (ghMessageLooksLikePrAlreadyExists(p.createError) && p.recoveredUrl) {
    return { ok: true, url: p.recoveredUrl, prOutcome: 'recovered' };
  }
  return {
    ok: Boolean(p.createOk),
    url: p.createUrl,
    error: p.createError,
    prOutcome: null,
  };
}

export function ghMessageLooksLikePrAlreadyExists(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    s.includes('already exists') ||
    s.includes('pull request already') ||
    (s.includes('a pull request') && s.includes('already'))
  );
}

/**
 * @param {{ reviewOutcome: string, reviewVerdict: string, postReviewAutofix: { ok?: boolean, mergeBlocked?: boolean, detail?: string } | null }} args
 */
export function autoMergeAllowedByReviewGate({ reviewOutcome, reviewVerdict, postReviewAutofix }) {
  if (reviewOutcome !== 'success') return false;
  if (reviewVerdict === VERDICT_APPROVE) return true;
  if (reviewVerdict === VERDICT_REQUEST_CHANGES) {
    return Boolean(postReviewAutofix?.ok);
  }
  return false;
}

/**
 * The autofix agent ends its reply with `AUTOFIX_NO_CHANGES: <reason>` when it judges the review
 * feedback wrong or not actionable and deliberately edits nothing.
 * @param {string} stdout agent output
 * @returns {string | null} the reason (text after the last sentinel), or null
 */
export function parseAutofixNoChanges(stdout) {
  const text = String(stdout || '');
  const marker = 'AUTOFIX_NO_CHANGES:';
  const at = text.lastIndexOf(marker);
  if (at === -1) return null;
  const reason = text
    .slice(at + marker.length)
    .replace(/^[\s*_`]+/, '')
    .replace(/\n--- process end[\s\S]*$/, '')
    .trim();
  return reason || '(no reason given)';
}

/**
 * Ensure the GitHub PR comment starts with an exact verdict line (automation-parseable).
 * @param {string} raw model output
 * @returns {{ verdict: typeof VERDICT_APPROVE | typeof VERDICT_REQUEST_CHANGES, bodyMarkdown: string, fullComment: string }}
 */
export function normalizePrReviewComment(raw) {
  const text = String(raw || '').trim();
  const lines = text.split(/\r?\n/);
  const parseVerdict = (line) => {
    const cleaned = String(line || '')
      .trim()
      .replace(/[*`]/g, '')
      .replace(/\s+/g, ' ');
    const m = cleaned.match(/^VERDICT:\s*(APPROVE|REQUEST_CHANGES)\s*\.?\s*$/i);
    if (!m) return null;
    return m[1].toUpperCase() === 'APPROVE' ? VERDICT_APPROVE : VERDICT_REQUEST_CHANGES;
  };

  // Find the first non-empty line, but tolerate small preambles by scanning a few lines.
  let firstNonEmpty = 0;
  while (firstNonEmpty < lines.length && !lines[firstNonEmpty].trim()) firstNonEmpty++;
  const scanLimit = Math.min(lines.length, firstNonEmpty + 6);
  let verdictLineIdx = -1;
  let verdict = null;
  for (let j = firstNonEmpty; j < scanLimit; j++) {
    const v = parseVerdict(lines[j]);
    if (v) {
      verdictLineIdx = j;
      verdict = v;
      break;
    }
  }

  const rest =
    verdictLineIdx >= 0 ? lines.slice(verdictLineIdx + 1).join('\n').trim() : lines.slice(firstNonEmpty + 1).join('\n').trim();

  if (verdict === VERDICT_APPROVE) {
    const fullComment = rest ? `${VERDICT_APPROVE}\n\n${rest}` : `${VERDICT_APPROVE}\n`;
    return { verdict: VERDICT_APPROVE, bodyMarkdown: rest, fullComment };
  }
  if (verdict === VERDICT_REQUEST_CHANGES) {
    const fullComment = rest ? `${VERDICT_REQUEST_CHANGES}\n\n${rest}` : `${VERDICT_REQUEST_CHANGES}\n`;
    return { verdict: VERDICT_REQUEST_CHANGES, bodyMarkdown: rest, fullComment };
  }

  const body = text || '_The model returned an empty review._';
  const fallbackBody =
    '_The automated reviewer did not put a valid verdict on the first line; defaulting to REQUEST_CHANGES._\n\n' +
    body;
  const fullComment = `${VERDICT_REQUEST_CHANGES}\n\n${fallbackBody}`;
  return { verdict: VERDICT_REQUEST_CHANGES, bodyMarkdown: fallbackBody, fullComment };
}
