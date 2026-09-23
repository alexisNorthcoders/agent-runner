import { createServer } from 'http';

/**
 * Localhost-only command API for the bot (bind to 127.0.0.1; there is no auth):
 *   POST /command {text, replyTo} → {reply}
 *   GET  /status                  → {busy, activeRun, paused}
 */

const MAX_BODY_BYTES = 256 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * @param {{
 *   runner: Pick<ReturnType<typeof import('./runner.js').createRunner>, 'handleCommand' | 'status'>,
 *   logger?: Pick<Console, 'error'>,
 * }} p
 */
export function createHttpServer({ runner, logger = console }) {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/status') {
        return send(res, 200, await runner.status());
      }
      if (req.method === 'POST' && path === '/command') {
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return send(res, 400, { reply: `Bad request: ${err.message}` });
        }
        const { text, replyTo } = body ?? {};
        if (typeof text !== 'string' || typeof replyTo !== 'string' || !replyTo) {
          return send(res, 400, { reply: 'Bad request: expected {text: string, replyTo: string}' });
        }
        return send(res, 200, await runner.handleCommand({ text, replyTo }));
      }
      return send(res, 404, { reply: 'Not found' });
    } catch (err) {
      logger.error(`${req.method} ${path} failed:`, err);
      return send(res, 500, { reply: `agent-runner error: ${err?.message || err}` });
    }
  });
}
