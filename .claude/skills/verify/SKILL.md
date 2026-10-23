---
name: verify
description: Start a sandboxed second agent-runner from this checkout and drive it the way the WhatsApp bot and the office dashboard do (POST /command, GET /status, the /office/feed SSE stream, scheduled jobs), with a stub agent, its own port, Redis DB and logs. Use to prove a change to agent-runner's runtime behavior before merging it, or whenever you need to see the real service answer without touching production.
---

# Verify agent-runner in a sandbox

Production agent-runner runs under PM2 from `~/Projects/agent-runner` on port 3790 with Redis DB 0. Never drive it to verify a change, and never start this repo with `npm start`, `pm2` or a plain `node src/main.ts`. Use `sandbox.sh`, which starts a second runner that can't reach production:

- **Code.** It runs a copy of this checkout's `src/`, `bin/` and `package.json` (working tree, uncommitted edits included) from `$DIR/app`, so `REPO_ROOT` and with it `logs/agent-runs`, `.env` and `scheduled-jobs.json` are the sandbox's own. The copy has no `.env`.
- **Env.** `env -i` plus an explicit list, so nothing leaks in from your shell (`CLAUDE*`, `pm_exec_path`, `AI_AGENT`, `GIT_EDITOR`). It gets a free port, `REDIS_URL=redis://127.0.0.1:6379/14`, a scratch `HOME` and `AGENT_WORKSPACE`, an empty workspace allowlist, the cron and session watch off, a one-day issue scan interval, a dead Joplin URL, and a scratch `SCHEDULED_JOBS_FILE` with one job.
- **Binaries.** `claude`, `gh` and `pm2` are stubs first on `PATH` (and in the scratch `~/.local/bin`, which agents and jobs get first). The `claude` stub prints a fixed stream-json run, so a freeform command costs nothing. `gh` and `pm2` fail, so `claude:restart` can't restart a real PM2 app. Every stub call is logged to `evidence/stub-calls.log`.

One path is shared. Redis pub/sub channels ignore the DB number, so the sandbox hears production's `agent-runner:state-changed` messages, and a sandbox `claude:restart` (through `bin/safe-restart.ts`) or `npm run agent:*` CLI publishes on production's channel. Production then re-reads its own DB 0 state and pushes an unchanged snapshot to its office feed. Nothing else crosses over. `claude:restart` in the sandbox ends with `safe-restart failed: ... pm2 is stubbed` in its outbox and the pause cleared.

`$DIR` is `${AGENT_RUNNER_VERIFY_DIR:-/tmp/agent-runner-verify}`. One sandbox runs at a time per `$DIR` and Redis DB. `AGENT_RUNNER_VERIFY_DB` picks another DB (never 0, which the script refuses). DB 15 is the store contract test's, so the default is 14.

## Launch

```sh
.claude/skills/verify/sandbox.sh smoke   # up, doctor, check, then down on any exit; exit 0 = PASS
```

`smoke` takes about 2 to 3 minutes, most of it waiting for the scheduled job. To drive by hand instead:

```sh
.claude/skills/verify/sandbox.sh up      # prints the pid, port and the job's due time
. /tmp/agent-runner-verify/state.env     # PID, PORT, JOB_AT
# ... drive it (features/) ...
.claude/skills/verify/sandbox.sh down
```

Ready means `GET /status` answers, which `up` waits for (30 s at most). `up` refuses if a sandbox is already running or the Redis DB has keys in it (a stranded run: `down` clears it).

## Doctor

```sh
.claude/skills/verify/sandbox.sh doctor
```

Read-only. It checks that the pid runs `$DIR/app/src/main.ts`, owns the port, and answers `/status`, that its `REDIS_URL` is the sandbox DB, that no harness or PM2 variable is in its environment, and that the cron is off. Run it first whenever something looks off. Any `FAIL` line means don't drive it: run `down` and `up`.

## Drive

`features/README.md` indexes one recipe per feature. All of them talk to `127.0.0.1:$PORT` exactly as the bot (`POST /command` with `{text, replyTo}`) and the dashboard (`GET /office/feed`) do. Messages the bot would deliver land in the sandbox's outbox: `redis-cli -n 14 XRANGE agent-runner:outbox - +`.

## Evidence

Everything goes to `$DIR/evidence/` and survives `down`: `server.log` (the runner's stdout and stderr), `stub-calls.log`, and from `check` the `claude:status` and `claude:history` replies, `status.json`, `feed.txt`, `outbox.txt`, `job.log`, and production's `/status` before and after.

Proof standards:

- Drive the user's path: `/command` text and the feed, not internal setters or Redis writes.
- Capture the request and the resulting state, and check the side effect (an outbox entry, `runs.jsonl` through `claude:history`, a job's log file) as well as the reply.
- Prove isolation on every run. `check` fails if production's outbox (DB 0), `runs.jsonl` or `jobs:last-fired` mention the sandbox's job or stub reply. For a change that might write elsewhere, also diff `redis-cli -n 0 --scan --pattern 'agent-runner:*' | sort` before and after.

## Cleanup

```sh
.claude/skills/verify/sandbox.sh down
```

It stops the pid it started (TERM, then KILL after 10 s), kills any process left that carries `AGENT_RUNNER_VERIFY_SANDBOX=$DIR` in its environment (the runner's agents and jobs inherit it), deletes `agent-runner:*` from the sandbox DB, and removes `app/`, `home/`, `workspace/`, `stubs/` and the state file. It keeps `evidence/`. It never kills by name. Run it after every failed attempt too.
