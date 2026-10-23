# Scheduled jobs

Commands the runner runs once a day at a fixed UTC time, configured in a JSON file (`SCHEDULED_JOBS_FILE`) that it re-reads every 30 s. A due job joins the run queue, runs under the lock as `sh -c <command>` with its output appended to its `logFile`, and is recorded in history. `agent-runner:jobs:last-fired` makes it fire at most once a day.

## Sub-features

- `job-adopt` records a new job when first seen: for yesterday if its time hasn't come (so it runs today), else for today (its first run is tomorrow).
- `job-fire` runs a due job and appends its output to `logFile`.
- `job-history` adds a `job` row, shown as `scheduled job <name>` in `claude:history`.
- `job-schedule` shows each job's `nextDueAt` in the office feed.

## How to get to it (user POV)

- The owner adds an entry to `scheduled-jobs.json` (see `scheduled-jobs.example.json`) and waits for its time.

## Driving it with curl

Preconditions:

- `up` wrote `$DIR/jobs.json` with `verify_echo` (`echo verify-job-ran`, `cwd` the scratch workspace, `logFile` `evidence/job.log`), due at `JOB_AT`, two minutes after `up` ran.

- **Adopted.** Right after `up`, `redis-cli -n 14 HGET agent-runner:jobs:last-fired verify_echo` is yesterday's UTC date.
- **Fired.** Within 30 s after `JOB_AT`, `server.log` has `scheduled jobs: verify_echo: Started run <id>: scheduled job verify_echo`, `evidence/job.log` has `verify-job-ran`, and the `last-fired` field is today's date.
- **History.** Once `/status` is `busy:false`, post `claude:history 5`. It lists `scheduled job verify_echo — success`.

## Gotchas

- A job whose time has already passed when it is first seen does not run today. That is the adopt rule, not a bug. To run another job, give it an `at` at least a minute ahead and add it to `$DIR/jobs.json`. The file is re-read on the next tick.
- A successful job sends nothing to the outbox, so look in history and the job log, not the outbox.
- `cwd` and `logFile` must be absolute. An invalid entry is dropped, and the error goes to the owner through the sandbox outbox.
