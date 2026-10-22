import { createServer } from 'http';
import { errorText, recordOrEmpty } from './narrow.ts';
import type { IncomingMessage, ServerResponse } from 'http';
import type { createRunner } from './runner.ts';
import type { createOfficeFeed } from './officeFeed.ts';

/**
 * Localhost-only command API for the bot (bind to 127.0.0.1; there is no auth):
 *   POST /command {text, replyTo} → {reply}
 *   GET  /status                  → {busy, activeRun, paused, queued}
 *   GET  /office/feed             → the office feed, an SSE stream of snapshots (read-only)
 */

const MAX_BODY_BYTES = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
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

export function createHttpServer({ runner, officeFeed, logger = console }: {
    runner: Pick<ReturnType<typeof createRunner>, 'handleCommand' | 'status'>;
    officeFeed?: Pick<ReturnType<typeof createOfficeFeed>, 'attach'>;
    logger?: Pick<Console, 'error'>;
  }) {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && path === '/status') {
        return send(res, 200, await runner.status());
      }
      if (req.method === 'GET' && path === '/office/feed' && officeFeed) {
        return await officeFeed.attach(req, res);
      }
      if (req.method === 'POST' && path === '/command') {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch (err) {
          return send(res, 400, { reply: `Bad request: ${errorText(err)}` });
        }
        const { text, replyTo } = recordOrEmpty(body);
        if (typeof text !== 'string' || typeof replyTo !== 'string' || !replyTo) {
          return send(res, 400, { reply: 'Bad request: expected {text: string, replyTo: string}' });
        }
        return send(res, 200, await runner.handleCommand({ text, replyTo }));
      }
      return send(res, 404, { reply: 'Not found' });
    } catch (err) {
      logger.error(`${req.method} ${path} failed:`, err);
      return send(res, 500, { reply: `agent-runner error: ${errorText(err)}` });
    }
  });
}
