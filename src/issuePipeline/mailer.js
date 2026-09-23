import nodemailer from 'nodemailer';

/**
 * Gmail SMTP for the post-close summary email (`GMAIL_EMAIL` / `GMAIL_PASSWORD`, an app password,
 * to `CLAUDE_REVIEW_EMAIL_TO`, default `GMAIL_EMAIL`).
 *
 * @typedef {(subject: string, body: { text: string, html: string }) => Promise<{ ok: boolean, to?: string, error?: string }>} SendMail
 */

/** @param {string} s */
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text wrapped in a minimal HTML page, so mail clients keep the line breaks. @param {string} plain */
export function plainTextEmailHtml(plain) {
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
<pre class="summary">${escapeHtml(plain)}</pre>
</body>
</html>`;
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
