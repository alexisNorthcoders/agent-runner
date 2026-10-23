# Status

The bot asks the runner whether it is busy (`GET /status`), and the owner asks for a readable summary with `claude:status`. Both read the lock, pause, queue and history.

## Sub-features

- `status-http` returns `{busy, activeRun, paused, queued}` as JSON.
- `status-command` replies with the agent, pause, cron, today's spend and recent runs.
- `history-command` lists the last n finished runs (`claude:history [n]`, 1 to 30).

## How to get to it (user POV)

- The bot calls `GET /status` before it forwards a command.
- The owner sends `claude:status` or `claude:history 5` on WhatsApp, which the bot forwards to `POST /command`.

## Driving it with curl

Preconditions:

- A fresh sandbox with no run started.

- **HTTP status.** Run `curl -s 127.0.0.1:$PORT/status`. The body is `{"busy":false,"activeRun":null,"paused":false,"queued":0}`.
- **Status command.** Post `claude:status`. The reply starts with `Agent: idle`, then `Paused: no`, `Cron: not started (no ticks recorded)`, `Today: 0 runs · $0.00 · 0 tok`, and `Recent:` with `no finished runs recorded yet`.
- **History command.** After a freeform run or a job, post `claude:history 5`. The reply starts `Last <n> runs:`, with one line per run, such as `scheduled job verify_echo_<NONCE> — success, 0s`.

## Gotchas

- The reply is the WhatsApp text, not the terminal table `npm run agent:status` prints. Don't look for `AGENTS` or `RECENT`.
- `/status` is `busy:true` while a job or run holds the lock. Wait for `busy:false` before you post `claude:history`, or the run in flight isn't in it yet.
