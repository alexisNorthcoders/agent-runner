# Freeform run

`claude <instructions>` starts an agent run in the default workspace. The command replies at once with the run id and log path. When the agent finishes, its final message reaches the bot through the outbox, and the run is added to history. In the sandbox the agent is the `claude` stub, which logs its arguments and prints a fixed successful run.

## Sub-features

- `freeform-start` replies `Started run <id> in <workspace>.` and the log path.
- `freeform-result` sends `Run <id> (<prompt>) finished (1 turns, $0.00).` with the agent's text to the `replyTo` it was given.
- `freeform-history` adds a `freeform` row to `runs.jsonl`.

## How to get to it (user POV)

- The owner sends `claude <instructions>` (or `claude sonnet: <instructions>`) on WhatsApp.

## Driving it with curl

Preconditions:

- No run is active (`/status` has `busy:false`).

- **Start.** Post `claude say hello to the verify sandbox`. The reply is `Started run <id> in /tmp/agent-runner-verify/workspace.` and `Log: /tmp/agent-runner-verify/app/logs/agent-runs/<id>.log`.
- **Agent call.** Read `evidence/stub-calls.log`. It has a `claude -p --model sonnet --output-format stream-json ...` line whose prompt ends with the instructions after the runner's preamble.
- **Result.** Within a few seconds, `redis-cli -n $DB XRANGE agent-runner:outbox - +` has an entry with `replyTo verify`, the text `Run <id> (say hello to the verify sandbox) finished (1 turns, $0.00).` and `verify stub reply`.
- **History.** Post `claude:history 5`. It lists `say hello to the verify sandbox — success`.

## Gotchas

- The log path names the sandbox copy (`$DIR/app/logs`), never the live checkout's `logs/`. If it doesn't, stop: the sandbox isn't isolated.
- The stub always succeeds. To verify failure handling, edit `$DIR/stubs/claude` (for example `exit 1` with no result line) after `up`. Don't change the stub in `sandbox.sh` for one run.
- With the allowlist empty, workspace inference never moves a run into a real repo. Don't add a real repo to `$DIR/workspaces.json`; the stub won't touch it, but the post-run git steps might.
