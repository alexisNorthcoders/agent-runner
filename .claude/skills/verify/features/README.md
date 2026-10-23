# agent-runner verification map

The maintained source for verifying agent-runner's user-facing behavior. Read this index before driving the sandbox, then use the matching feature file as the recipe.

## Baseline preconditions

- A sandbox from `.claude/skills/verify/sandbox.sh up`, and `sandbox.sh doctor` prints no `FAIL`.
- `. /tmp/agent-runner-verify/state.env` gives `DB`, `NONCE`, `JOB`, `PID`, `PORT` and `JOB_AT` (paths here assume the default `AGENT_RUNNER_VERIFY_DIR`).
- Redis DB `$DB` (14 by default) holds only what this sandbox wrote. The workspace allowlist is empty, and the cron is off.
- Never drive production (port 3790, DB 0) or an instance this run didn't start.

## Driving conventions

- Send commands as the bot does: `curl -s -X POST 127.0.0.1:$PORT/command -H 'content-type: application/json' -d '{"text":"<command>","replyTo":"verify"}'`. The answer is `{"reply": "..."}`.
- Read what the bot would deliver later from the outbox: `redis-cli -n $DB XRANGE agent-runner:outbox - +`.
- Never use `npm run agent:*` or `bin/` against the sandbox. From a checkout they act on production. Every action they offer has a `claude:` command.
- Treat command text as literal. `claude:<word>` is a subcommand, and `claude <words>` is a freeform run.

## Proof and skip reporting

- Save the request, the reply and the resulting state under `/tmp/agent-runner-verify/evidence/`.
- Check the side effect (an outbox entry, a history row, a job log) as well as the reply.
- Report a feature you couldn't reach with the command you tried and the precondition that was missing. Don't report it verified through another path.

## Features

| Feature | File | Covered by `check` |
|---|---|---|
| Status, over HTTP and as `claude:status` | [status.md](status.md) | yes |
| Office feed (SSE) | [office-feed.md](office-feed.md) | yes |
| Freeform run with the stub agent | [freeform-run.md](freeform-run.md) | yes |
| Scheduled job | [scheduled-jobs.md](scheduled-jobs.md) | yes |

Not mapped yet: issue runs (`claude issue:<alias>:<n>`) need an allowlisted scratch repo and a `gh` fake; `claude joplin:<note>` needs a Joplin API fake; pauses (`claude:pause`, `claude:resume`), `claude:stop`, `claude:queue` and `claude:more` work in the sandbox but have no recipe yet.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the behavior. It then has four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with curl`, and `Gotchas`.
