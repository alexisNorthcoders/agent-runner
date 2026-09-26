import nodemailer from 'nodemailer';

/**
 * Gmail SMTP for the post-close summary email (`GMAIL_EMAIL` / `GMAIL_PASSWORD`, an app password,
 * to `CLAUDE_REVIEW_EMAIL_TO`, default `GMAIL_EMAIL`).
 *
 * @typedef {(subject: string, body: { text: string, html: string }) => Promise<{ ok: boolean, to?: string, error?: string }>} SendMail
 */

/** @param {string} s */
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Plain text wrapped in a minimal HTML page, so mail clients keep the line breaks.
 * @param {string} plain @param {string} [headerHtml] trusted HTML put before the text
 */
export function plainTextEmailHtml(plain, headerHtml = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Issue closed — summary</title>
<style>
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; line-height: 1.5; color: #1f2328; max-width: 52rem; margin: 0 auto; padding: 1rem 1.25rem; }
pre.summary { white-space: pre-wrap; font-size: 0.95rem; margin: 0; }
</style>
</head>
<body>
${headerHtml}<pre class="summary">${escapeHtml(plain)}</pre>
</body>
</html>`;
}

const POST_CLOSE_SUBJECT_TITLE_MAX_CHARS = 80;

/**
 * The post-close changes-summary email. The subject and a header name the issue (number, title,
 * issue and PR links), so the email identifies itself even when the LLM summary doesn't. The
 * summary follows the header unchanged.
 * @param {{ subjectPrefix: string, issueNumber: number, title?: string | null, issueUrl?: string | null, prUrl?: string | null, summary: string }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildPostCloseChangesEmail({ subjectPrefix, issueNumber, title, issueUrl, prUrl, summary }) {
  const cleanTitle = String(title ?? '').replace(/\s+/g, ' ').trim();
  const subjectTitle =
    cleanTitle.length > POST_CLOSE_SUBJECT_TITLE_MAX_CHARS ? `${cleanTitle.slice(0, POST_CLOSE_SUBJECT_TITLE_MAX_CHARS - 1).trimEnd()}…` : cleanTitle;
  const subject = subjectTitle
    ? `[${subjectPrefix}] Issue #${issueNumber} closed: ${subjectTitle}`
    : `[${subjectPrefix}] Issue #${issueNumber} closed — changes summary`;

  const heading = cleanTitle ? `Issue #${issueNumber}: ${cleanTitle}` : `Issue #${issueNumber}`;
  /** @type {Array<[string, string]>} */
  const links = [];
  if (issueUrl) links.push(['Issue', String(issueUrl)]);
  if (prUrl) links.push(['Pull request', String(prUrl)]);

  const text = [heading, ...links.map(([label, url]) => `${label}: ${url}`), '', '---', '', summary].join('\n');
  const linkItems = links.map(([label, url]) => `<li>${label}: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`).join('\n');
  const headerHtml = `<h2>${escapeHtml(heading)}</h2>\n${linkItems ? `<ul>\n${linkItems}\n</ul>\n` : ''}<hr>\n`;
  return { subject, text, html: plainTextEmailHtml(summary, headerHtml) };
}

/**
 * @param {import('./settings.js').PipelineSettings['email']} email
 * @returns {SendMail}
 */
export function createGmailSender({ user, pass, to }) {
  return async (subject, { text, html }) => {
    if (!user || !pass || !to) {
      return { ok: false, error: 'Gmail is not configured (GMAIL_EMAIL / GMAIL_PASSWORD) or CLAUDE_REVIEW_EMAIL_TO is missing.' };
    }
    try {
      await nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }).sendMail({ from: user, to, subject, text, html });
      return { ok: true, to };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };
}
