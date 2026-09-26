# agent-runner

A standalone PM2 service on the Pi that runs headless coding-agent sessions (Claude Code CLI) for
the WhatsApp bot. The bot forwards `claude…` messages over localhost HTTP, and the runner reports
back through a Redis Stream outbox that the bot delivers. Design:
WhatsappBot `docs/adr/0001-agent-runner-out-of-process.md`.

Built so far: freeform runs, `joplin:` runs, the GitHub issue pipeline (`claude issue:…`),
`claude:stop`, `claude:restart`, status/history (`claude:status`, `claude:history`,
`npm run agent:*`), the cron issue tracer, scheduled jobs, and the office dashboard's feed and plain panel.

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
| `claude <instructions>` | Run the agent in `~/Projects` (`AGENT_WORKSPACE`). If it changes a git repo, its preamble has it branch, commit, push, open a PR, review it, merge it and return to the default branch (`src/preamble.js`). |
| `claude joplin:<note title or id>` | Use a note from the `WhatsApp Bot` notebook as the instructions (Joplin Data API). |
| `claude issue:<alias>:<n> [extra instructions]` | Implement GitHub issue `n` in the allowlisted `<alias>` workspace, then commit, PR, review and merge. See [Issue runs](#issue-runs). |
| `claude issue:<n> [extra instructions]` | The same, in the `CLAUDE_ISSUE_DEFAULT_ALIAS` workspace. |
| `claude:stop` | Kill the active run, or the active [scheduled job](#scheduled-jobs)'s command. Its "stopped" report lands in the outbox, and the next queued request starts. |
| `claude:queue` | List the requests waiting for the agent. |
| `claude:queue clear` | Drop every waiting request. |
| `claude:pause [<alias>] [2h] [reason]` | Pause by hand while you work in a repo yourself (duration `30m`, `2h`, `1d`, up to 7d; default 2h). With no alias, no new run starts anywhere: requests queue and the cron skips its ticks. With an alias, only issue runs there are refused (the cron moves on to the next workspace), and freeform runs are told to leave it alone. A run already going is not stopped. |
| `claude:resume [<alias>]` | End that pause early, or every pause with no alias. |
| `claude:restart` | Run safe-restart in the background, then report to the outbox. |
| `claude:status` | Active run (with orphaned/stale warnings), pause, last cron tick, today's spend, last 3 runs. |
| `claude:history [n]` | The last `n` finished runs (default 10, max 30) with outcome, duration, cost and tokens. |

There is one run at a time. A run request (`claude …`, `joplin:`, `issue:`) that arrives while a
run is active, the runner is paused, or other requests are already waiting joins a FIFO queue
(max 20) and gets a "Queued (position n)" reply. When a run finishes, the oldest queued request
starts, and its "Started run …" reply (or why it couldn't start) goes to the outbox. The queue is
in Redis, so it survives a restart, and the runner re-checks it every 15s (e.g. after a pause
ends). The cron skips its tick while anything is queued. A due [scheduled job](#scheduled-jobs) joins
the same queue. Status and history
replies are a single compact message, with no log paths or excerpts.

## Terminal status

```sh
npm run agent:status            # snapshot: cron, active runs, pause, spend, recent runs (--json)
npm run agent:watch             # the same, refreshed every 2s (agent:watch -- 5 for 5s)
npm run agent:history -- -n 20  # finished runs with model, tokens and cost (--json)
npm run agent:logs -- -f        # print or follow a run's log: [runId|prefix|latest] [-f]
npm run agent:pause -- chess-trainer 1h fixing lessons   # same as claude:pause, works while the runner is down
npm run agent:resume            # end every pause (agent:resume -- <alias> for one)
```

These read `logs/agent-runs/` directly (plus the pause flag, lock and cron state from Redis), so they work while the
runner is down. An active run's `state` is `running`, `orphaned` (the runner died but the agent
process is still going, so nobody will report its result) or `stale` (both are gone). The runner
deletes stale active files on startup and on every cron tick, and keeps orphaned ones.

## Issue runs

`claude issue:<alias>:<n>` branches **in place** in the target repo (no clone or worktree; see the
ADR), under one lock like any other run:

1. **Workspace**: `<alias>` must be in the allowlist (`CLAUDE_WORKSPACE_MAP` and/or the JSON
   `CLAUDE_WORKSPACE_MAP_FILE`), resolved with realpath. Only issue runs use the allowlist.
2. **Prep**: `gh issue view` (the repo comes from `CLAUDE_ISSUE_REPO_MAP`, else the workspace's GitHub
   `origin`; unlike the bot, there is no fallback to WhatsappBot), then with a clean tree: fetch, check out and fast-forward the default branch (`main`
   or `master`, from `origin/HEAD`), and create `claude/issue-<n>-<slug>`. If that issue already
   has a local branch, the run **resumes** on it, and the prompt says what is already there
   (commits, uncommitted files, an open PR and its conflicts). A prep failure is the HTTP reply.
3. **Agent**: Claude with the `/implement` skill, in the repo.
4. **Post-run** (`src/issuePipeline/postRun.js`): commit, push, open or reuse the PR (`Fixes #n`), an
   LLM review posted as a PR comment, **one** autofix agent pass on `VERDICT: REQUEST_CHANGES`, then
   merge (auto-merge, or a direct merge when there's no gate) with the repo's allowed method, wait
   for the issue to close, the summary email, and back to the default branch. If the agent didn't
   finish, its leftover work is committed as a WIP snapshot so the next run resumes.
5. **One outbox message**: `✅ #n merged — title`, `✅ #n PR open …`, or `⚠️ #n: <problem> — needs a
   look.` The full narrative is appended to the run log.

Each post-run step has a `CLAUDE_POST_RUN*` flag (see `.env.example`). `claude:stop` stops the
agent or the autofix pass; post-run's `gh`/`git` steps themselves run to completion.

If the runner dies mid-run, the next start reports the run as interrupted to `owner`,
WIP-commits leftover work on the issue branch (never on another branch), and says which command
resumes it. An agent that outlived its runner is stopped first, but only if its pid still belongs
to a headless Claude run.

## Cron issue tracer

Every `CRON_ISSUE_TRACER_INTERVAL_MS` (default 10 minutes) the runner looks for one open issue
labelled `ready-for-agent` and runs it as an issue run (`trigger: cron`), reporting to `owner`.
Turn it off with `CRON_ISSUE_TRACER_DISABLE=1` (which also clears its state from the status views). **Only one cron may run:** disable the WhatsappBot
in-process cron (`CRON_ISSUE_TRACER_DISABLE=1` in its `.env`) before enabling this one.

- **Workspaces**, in order: `CLAUDE_ISSUE_DEFAULT_ALIAS`, then `CRON_SECONDARY_WORKSPACE_ALIASES`
  (comma-separated; else `CRON_PLATFORMER_WORKSPACE_ALIAS`, default `platformer`). Each must be in
  the allowlist; one that isn't is skipped with a log line. The first workspace with a runnable
  issue wins, and within it the lowest issue number.
- **Skips**: the whole tick while the lock is held or agent-runner is paused; issues that GitHub's
  native dependencies mark as blocked (a failed lookup counts as blocked).
- **Progress**: a run that pushed, opened a PR or merged records the issue as its repo's
  last-started, and the cron doesn't pick it again. A failed, empty or timed-out run doesn't count,
  so the next tick retries it (an empty run, which the runner otherwise keeps quiet about, gets a
  one-line note to `owner`).
- **Open agent PRs** are worked once per PR state (head commit + base tip). While that state is
  unchanged the issue is parked, and the owner is told once.
- If the issue can't be fetched or branched, the owner is told and the next tick retries.

State is in Redis (below) and starts fresh: nothing is migrated from the bot's JSON files.

## Scheduled jobs

Commands the runner runs once a day at a fixed UTC time, in place of crontab lines (the first are
reddit-bot's `cleanup_agent` and `report_agent`). They are not agent runs: the command runs as-is,
with no preamble and no post-run.

**Config**: a JSON array in `SCHEDULED_JOBS_FILE` (default `scheduled-jobs.json` in this repo,
gitignored; see [`scheduled-jobs.example.json`](scheduled-jobs.example.json)). It is re-read every
30s, so an edit applies without a restart, and a missing file means no jobs. A bad entry is
skipped, and `owner` is told once per change of the errors.

```jsonc
[
  {
    "name": "cleanup_agent",           // unique; letters, digits, _ . -
    "room": "reddit-bot",              // label for the office dashboard
    "cwd": "/home/alexis/Projects/reddit-bot",   // absolute
    "command": "npm run cleanup_agent",          // run with `sh -c` in cwd
    "at": "02:00",                     // daily, HH:MM UTC
    "logFile": "/home/alexis/Projects/reddit-bot/reports/cron-cleanup.log",  // optional
    "env": { "CLAUDE_AGENT_BIN": "/home/alexis/.local/bin/claude" },         // optional, added to the runner's env
    "timeoutMinutes": 30               // optional, 1–60; default 60
  }
]
```

- **Queueing**: when a job is due it joins the run queue as a `job` request (`owner` is its
  `replyTo`), so it waits behind an active run, queued requests and pauses like any other request.
- **Running**: `sh -c <command>` in `cwd`, in its own process group, under the lock. stdout and
  stderr are appended to `logFile` through one file descriptor, so the file is exactly what
  `>> file 2>&1` in crontab produced (and its modification time moves the same way). Without a
  `logFile` the output goes to `logs/agent-runs/<runId>.log`. `claude:stop` or the timeout kills the
  whole process group.
- **Records**: a history row with `kind: job`, `trigger: schedule`, `jobName`, `room`, `outcome`
  (`success`, `failed`, `timeout`, `stopped`, `spawn_error`), `exitCode` and `durationMs`. It shows
  in `claude:status`, `claude:history` and `npm run agent:*` as `scheduled job <name>`. A success is
  quiet; anything else sends one line to `owner`.
- **Once a day**: `agent-runner:jobs:last-fired` records the UTC day each job last joined the
  queue, so it fires at most once a day, even across restarts. A job whose time passed while the
  runner was down fires on startup that day. A job new to the config whose time already passed
  today first runs tomorrow, so moving a job over from crontab never runs it twice that day.
- **Startup recovery**: an interrupted job run is reported to `owner`. There is no WIP commit, and
  a job process that outlived the runner is left alone (the report says so).

Moving a crontab line over: add the job to the config, then remove the line from `crontab -e`.

## HTTP API (127.0.0.1 only, no auth)

- `POST /command {text, replyTo}` → `{reply}`. The reply is synchronous ("Started run X", "Queued (position n)…",
  a usage/parse error). `replyTo` is opaque and is echoed on the run's outbox messages.
- `GET /status` → `{busy, activeRun, paused, queued}`. `activeRun` includes live progress (`lastActivity`,
  `turns`, tokens).
- `GET /office/feed` → the [office feed](#office-dashboard), a read-only SSE stream of office snapshots.

```sh
curl -s localhost:3790/status
curl -s localhost:3790/command -H 'content-type: application/json' \
  -d '{"text":"claude say hi","replyTo":"test"}'
```

## Office dashboard

A LAN page that shows the runner live: a pixel-art office scene, and beside it the **Now**,
**History** and **Office** tabs as plain text and tables (the plan is #17). The page is static files in
`dashboard/` with no build step, served by nginx, and it gets everything from the office feed. The
terms (Office, Cubicle, Reception, …) are in [`CONTEXT.md`](CONTEXT.md).

### Office feed

`GET /office/feed` on the runner's 127.0.0.1 port is a [Server-Sent Events][sse] stream. It is
read-only: it takes no input and there is no control route beside it.

- On connect it sends a full snapshot, then a new one after every state change: a run starting or
  ending, agent progress, the phase, the queue, a pause, a cron tick, the lock.
- Changes come from the runner's one internal change notification (`src/stateChanges.js`): every
  Redis state write goes through a notifying store, and the runner reports progress, phase and runs
  ending. Changes are coalesced, so pushes are at least 1s apart and a change shows within ~1.3s.
- Writes by other processes (`npm run agent:pause` / `agent:resume`, safe-restart's pause flag)
  are published on the Redis channel `agent-runner:state-changed`, which the runner subscribes to,
  so they push too.
- Every 30s the snapshot is resent anyway. That keeps the connection open through proxies, and
  catches what nothing announces (a run turning orphaned or stale, a pause expiring).
- Each event is `event: snapshot` with the JSON on one `data:` line. Up to 20 clients.

### Live log

The feed also streams the active run's log (`src/logTail.js`), including an autofix pass's own log,
as `event: log` with `{ runId, reset, lines }`. While anyone is connected the runner polls the log
every 500ms. A client that connects mid-run gets the last 200 lines right after its first snapshot
(`reset: true`), then new lines as they are written (`reset: false`). A new run sends `reset: true`
with its lines, so the pane clears. Lines over 2000 characters are cut. Only the active run's log is
streamed; past runs stay history rows. A scheduled job's `logFile`, which every run appends to,
is streamed from where the job started, so earlier runs' output doesn't show.

Before a line leaves the runner, obvious secrets are masked (`src/maskSecrets.js`): GitHub tokens
(`ghp_…`, `gho_…`, `github_pat_…`), `sk-…` API keys, bearer tokens, and the value of
`…_KEY=` / `_TOKEN=` / `_SECRET=` / `_PASSWORD=` assignments (and of such keys in JSON). **This is best effort.** It catches
the common shapes, not every secret, so treat the page as seeing the raw log and keep it on the LAN.

```sh
curl -sN localhost:3790/office/feed
```

### Snapshot shape

`OfficeSnapshot` in `src/officeSnapshot.js` (JSDoc-typed) is the contract. It is built from the
same status snapshot as `npm run agent:status`, plus the live phase and progress the runner holds
in memory, so the numbers match. It carries no paths, reply addresses or prompts.

```jsonc
{
  "version": 1,                        // bumped on a breaking change
  "at": "2026-09-26T04:44:30.885Z",    // when it was taken
  "activeRun": {                       // the run this runner is executing, or null
    "runId": "…", "kind": "issue", "trigger": "cron",   // trigger: "cron" | "manual" | "schedule"
    "label": "issue bot#7 \"Fix it\"", "workspaceAlias": "bot", "issueNumber": 7,
    "room": null,                      // a scheduled job's room, else null
    "health": "running",               // running | orphaned | stale
    "phase": "agent",                  // agent | post-run | job, null if not run by this process
    "model": "claude-opus-5-5", "turns": 12, "outputTokens": 900, "contextTokens": 136635,
    "lastActivity": "Read src/a.js", "startedAt": "…", "elapsedMs": 378907, "agentPid": 583232
  },
  "active": [ /* every in-flight run agent:status lists, orphaned and stale too, same shape */ ],
  "queue": [ { "id": "…", "kind": "freeform", "label": "…", "queuedAt": "…" } ],
  "pauses": {
    "restart": null,                   // safe-restart's flag: {reason, pausedAt}, null or "unknown"
    "general": null,                   // by hand: {reason, pausedAt, until} or null
    "workspaces": [ { "alias": "chess-trainer", "reason": "…", "pausedAt": "…", "until": "…" } ]
  },
  "cron": {                            // null when the cron hasn't started
    "alive": true, "pid": 579608, "intervalMs": 600000,
    "lastTickStartedAt": "…", "lastTickEndedAt": "…", "outcome": { "kind": "no_eligible" },
    "nextTickAt": "…"                  // last tick start + interval; null before a tick or if dead
  },
  "lock": { "runId": "…", "kind": "issue", "trigger": "cron", "label": "…",
            "workspaceAlias": "bot", "issueNumber": 7, "startedAt": "…" },  // or null
  "history": [                         // the last 7 days, newest first
    { "runId": "…", "kind": "issue", "trigger": "cron", "label": "…", "workspaceAlias": "bot",
      "issueNumber": 7, "startedAt": "…", "endedAt": "…", "durationMs": 60000,
      "outcome": "success", "result": "merged", "model": "…", "turns": 3,
      "costUsd": 1.2, "tokens": 1700000 }   // tokens: input + output + cache
  ],
  "spend": { "today": { "runs": 1, "costUsd": 2.33, "tokens": 2900000 },   // since local midnight
             "week":  { "runs": 24, "costUsd": 28.7, "tokens": 32300000 } },
  "workspaces": ["agent-runner", "bot", "chess-trainer"]   // allowlisted aliases, sorted
}
```

Add fields freely; bump `version` for anything that breaks a reader.

### The page

`dashboard/index.html` + `app.js` (rendering) + the scene's modules (below) + `format.js` (number formatting, kept in step with
`src/statusFormat.js` by a test) + `logPane.js` (the live log's lines). The Now tab tails the
active run's log in a monospace pane that auto-scrolls, with a button to pause and resume
scrolling. It opens the feed at the relative URL `feed`, re-renders every
second so elapsed times and the cron countdown move, and says **runner down** while the feed
can't connect (or has been silent for 75s), reconnecting by itself every 3s.

### The office scene

The office floor is drawn on a `<canvas>` next to the panel: an open-plan bullpen with one cubicle
per allowlisted workspace, the boss's office and the Library on the left, and Reception (by the
front door) and the Annex on the right. It shows the office-level state:

- **Runner down:** the whole office is dark, apart from the EXIT sign.
- **General pause** (`claude:pause`): a "BACK IN 5" sign on the front door.
- **Workspace pause:** a "Do not disturb" sign on that cubicle.
- **Reception:** the mail carrier at the desk, a countdown on the wall to the cron's next tick
  (hidden when the cron isn't running), and one letter on the mail cart per queued request (hover
  a letter for its label; a full cart piles the rest into its last slot).

Pauses clear on the page as soon as they run out, without waiting for the next snapshot.

The scene is drawn at a small internal resolution (360px tall, 560–720px wide) and scaled up by a
whole number with smoothing off, so the pixels stay crisp. On a wide screen it takes about 65% of
the width with the panel on the right; under 900px the panel goes below it, and under 560px the
rooms stack vertically (Reception first).

Cubicle names and order come from [`dashboard/office.json`](dashboard/office.json):

```json
{ "cubicles": [{ "alias": "agent-runner", "name": "IT" }, { "alias": "bot", "name": "Customer Svc" }] }
```

Listed aliases come first, in that order. Allowlisted aliases it doesn't list follow, named by
their alias, and listed aliases that aren't allowlisted are ignored. Keep names short: about 12
characters fit a sign at every size.

The code is split so the rules are testable and the art is replaceable: `scene.js` is the pure
scene reducer (snapshot + previous scene → scene, tested), `layout.js` places the rooms and
cubicles (tested), `sprites.js` draws every sprite procedurally (swap it for sprite sheets later),
and `officeView.js` draws a scene on a layout with the sprites.

### nginx

[`docs/nginx/office.conf`](docs/nginx/office.conf) is an example snippet to include in a `server`
block: it serves `dashboard/` on `/office/` and proxies `/office/feed` to the runner with
buffering off. It allows only localhost and `192.168.0.0/16`, since the page has no auth. The
runner's port stays bound to 127.0.0.1.

```sh
sudo cp docs/nginx/office.conf /etc/nginx/snippets/agent-runner-office.conf
# add `include snippets/agent-runner-office.conf;` to a server block, then:
sudo nginx -t && sudo systemctl reload nginx     # open http://<pi>/office/
```

[sse]: https://html.spec.whatwg.org/multipage/server-sent-events.html

## Redis

| Key | Type | Purpose |
| --- | --- | --- |
| `agent-runner:outbox` | stream | Messages for the bot: `XADD {replyTo, text, runId, ts}`, trimmed to ~7 days (`MINID ~`). System messages use `replyTo=owner`. |
| `agent-runner:lock` | string (JSON) | Single-flight lock holding the active run's record. It is TTL'd, and on startup a leftover lock is reported to `owner` as an interrupted run. |
| `agent-runner:queue` | list (JSON) | Run requests waiting for the agent, oldest first: `{id, cmd, replyTo, label, queuedAt}`. |
| `agent-runner:paused` | string (JSON) | Pause flag set by safe-restart. It is TTL'd, and only its setter (by token) clears it. The cron skips its ticks while it's set. |
| `agent-runner:manual-pause` | hash | Pauses set by hand: `all` or a workspace alias → `{scope, reason, pausedAt, until}`. Expired fields are ignored and deleted on read. |
| `agent-runner:cron:state` | string (JSON) | The cron's last tick (`pid`, `intervalMs`, times, outcome), for the status views. |
| `agent-runner:cron:last-started` | hash | `owner/repo` → the last issue the cron made progress on there. |
| `agent-runner:cron:pr-attempts` | hash | `owner/repo#n` → the PR state (`headSha:baseSha`) the cron last worked. Not written when an approved PR's merge failed only on a network error, so the next tick works it again. |
| `agent-runner:state-changed` | pub/sub channel | The CLIs and safe-restart publish the key of each state write they make, so the runner's office feed pushes. |
| `agent-runner:cron:park-notices` | hash | `owner/repo#n` → the parked PR state the owner was last told about. |
| `agent-runner:jobs:last-fired` | hash | Scheduled job name → the UTC day (`YYYY-MM-DD`) it last joined the queue. `hdel` a field to let a job fire again today. |

```sh
redis-cli XREVRANGE agent-runner:outbox + - COUNT 5
redis-cli HGETALL agent-runner:cron:last-started   # hdel a field to let the cron pick an issue again
```

## Safe restart

`npm run safe-restart`: refuse if a run is active → set the pause flag → `pm2 restart agent-runner`
→ wait for `/status` → clear the pause. The runner never clears a pause it didn't set. Agent runs
are told the same rule in their prompt preamble.

## Layout

- `src/main.js`: wiring (Redis, HTTP on 127.0.0.1, startup recovery).
- `src/runner.js`: command handling, the run lifecycle and status.
- `src/commands.js`: parses `claude…` text.
- `src/preamble.js`: the rules prepended to every agent prompt. Freeform and Joplin runs add the git rules, and issue runs don't, since their post-run commits and merges.
- `src/agentBackend/`: the `AgentBackend` seam. `claude.js` holds everything Claude-specific (CLI
  flags, stream-json parsing, cost/tokens, `/implement`).
- `src/runLock.js`, `src/runQueue.js`, `src/pauseFlag.js`, `src/manualPause.js`, `src/outbox.js`, `src/cronState.js`: Redis state over
  `src/redisStore.js`.
- `src/cronTracer.js`: the cron issue tracer (picking, parking, progress), over `runner.startIssueRun`.
- `src/scheduledJobs.js`: scheduled jobs' config and once-a-day scheduler, over `runner.submitJob`.
  `src/jobProcess.js` runs a job's command with its output appended to the log file.
- `src/safeRestart.js` + `bin/safe-restart.js`: restart decision logic and the CLI.
- `src/joplin.js`: Joplin Data API client.
- `src/workspaces.js`: the issue-run workspace allowlist.
- `src/issuePipeline/`: issue runs. `index.js` is the entry point (`prepare` before the agent,
  `finish` after it, `commitInterruptedWork` for startup recovery), shared by manual runs and the
  cron. `gitWorkspace.js` (branching, commits), `githubPr.js` (PR, merge), `githubIssue.js`,
  `postRun.js`, `llm.js` (review and summary over `fetch`), `mailer.js`. All `git`/`gh` calls go
  through the injectable `exec.js`.
- `src/activeRuns.js`, `src/runHistory.js`: the files under `logs/agent-runs/`.
- `src/statusCollect.js` + `src/statusFormat.js`: the status snapshot and its terminal/WhatsApp
  rendering. `bin/agent-cli.js` is the terminal CLI.
- `src/stateChanges.js`: the runner's "state changed" notification, and the Redis store that raises it.
- `src/officeSnapshot.js` + `src/officeFeed.js`: the office snapshot and the SSE feed that pushes it.
- `src/logTail.js` + `src/maskSecrets.js`: the feed's live log of the active run, masked.
- `dashboard/`: the office dashboard page (static, no build). `docs/nginx/office.conf` serves it.
- `logs/agent-runs/`: one `<runId>.log` per run (plus `<runId>-autofix.log`), `active/<runId>.json`
  per in-flight run (live progress), `runs.jsonl` history (an issue run's `costUsd` includes its
  autofix pass).

## Tests

```sh
npm test            # node:test with injected fakes; the Redis contract test uses DB 15 if Redis is up
npm run typecheck   # tsc --checkJs
```
