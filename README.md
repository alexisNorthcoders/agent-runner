# agent-runner

A standalone PM2 service on the Pi that runs headless coding-agent sessions (Claude Code CLI) for
the WhatsApp bot. The bot forwards `claude…` messages over localhost HTTP, and the runner reports
back through a Redis Stream outbox that the bot delivers. Design:
WhatsappBot `docs/adr/0001-agent-runner-out-of-process.md`.

This is the first slice: freeform runs, `joplin:` runs, `claude:stop` and `claude:restart`. The
GitHub issue pipeline and the cron issue tracer come later.

## Setup

```sh
npm install
cp .env.example .env        # optional; defaults work on the Pi
pm2 start ecosystem.config.cjs && pm2 save
```

After the first start, **restart it only with `npm run safe-restart`** (or `claude:restart` from
WhatsApp), never with `pm2 restart agent-runner`. See [Safe restart](#safe-restart).

## Commands (the `text` of `POST /command`)

| Text | Effect |
| --- | --- |
| `claude <instructions>` | Run the agent in `~/Projects` (`AGENT_WORKSPACE`). |
| `claude joplin:<note title or id>` | Use a note from the `WhatsApp Bot` notebook as the instructions (Joplin Data API). |
| `claude:stop` | Kill the active run. Its "stopped" report lands in the outbox. |
| `claude:restart` | Run safe-restart in the background, then report to the outbox. |

There is one run at a time and no queue: a request while busy is rejected.

## HTTP API (127.0.0.1 only, no auth)

- `POST /command {text, replyTo}` → `{reply}`. The reply is synchronous ("Started run X", "busy…",
  a usage/parse error). `replyTo` is opaque and is echoed on the run's outbox messages.
- `GET /status` → `{busy, activeRun, paused}`. `activeRun` includes live progress (`lastActivity`,
  `turns`, tokens).

```sh
curl -s localhost:3790/status
curl -s localhost:3790/command -H 'content-type: application/json' \
  -d '{"text":"claude say hi","replyTo":"test"}'
```

## Redis

| Key | Type | Purpose |
| --- | --- | --- |
| `agent-runner:outbox` | stream | Messages for the bot: `XADD {replyTo, text, runId, ts}`, trimmed to ~7 days (`MINID ~`). System messages use `replyTo=owner`. |
| `agent-runner:lock` | string (JSON) | Single-flight lock holding the active run's record. It is TTL'd, and on startup a leftover lock is reported to `owner` as an interrupted run. |
| `agent-runner:paused` | string (JSON) | Pause flag set by safe-restart. It is TTL'd, and only its setter (by token) clears it. |

```sh
redis-cli XREVRANGE agent-runner:outbox + - COUNT 5
```

## Safe restart

`npm run safe-restart`: refuse if a run is active → set the pause flag → `pm2 restart agent-runner`
→ wait for `/status` → clear the pause. The runner never clears a pause it didn't set. Agent runs
are told the same rule in their prompt preamble.

## Layout

- `src/main.js`: wiring (Redis, HTTP on 127.0.0.1, startup recovery).
- `src/runner.js`: command handling, the run lifecycle and status.
- `src/commands.js`: parses `claude…` text.
- `src/agentBackend/`: the `AgentBackend` seam. `claude.js` holds everything Claude-specific (CLI
  flags, stream-json parsing, cost/tokens, `/implement`).
- `src/runLock.js`, `src/pauseFlag.js`, `src/outbox.js`: Redis state over `src/redisStore.js`.
- `src/safeRestart.js` + `bin/safe-restart.js`: restart decision logic and the CLI.
- `src/joplin.js`: Joplin Data API client.
- `logs/agent-runs/`: one `<runId>.log` per run, plus `runs.jsonl` history.

## Tests

```sh
npm test            # node:test with injected fakes; the Redis contract test uses DB 15 if Redis is up
npm run typecheck   # tsc --checkJs
```
