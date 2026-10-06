# agent-runner

A standalone PM2 service on the Pi that runs headless coding-agent sessions (Claude Code CLI) for
the WhatsApp bot. The bot forwards `claude…` messages over localhost HTTP, and the runner reports
back through a Redis Stream outbox that the bot delivers. Design:
WhatsappBot `docs/adr/0001-agent-runner-out-of-process.md`.

Built so far: freeform runs, `joplin:` runs, the GitHub issue pipeline (`claude issue:…`),
`claude:stop`, `claude:restart`, status/history (`claude:status`, `claude:history`,
`npm run agent:*`), the cron issue tracer, scheduled jobs, and the office dashboard's feed, plain panel and scene, with each repo's pending issues.

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
| `claude <instructions>` | Run the agent in `~/Projects` (`AGENT_WORKSPACE`). If it changes a git repo, its preamble has it branch, commit, push, open a PR, review it, merge it and return to the default branch (`src/preamble.js`). The runner infers which allowlisted workspace it works in (see [Freeform runs' workspace](#freeform-runs-workspace)). |
| `claude joplin:<note title or id>` | Use a note from the `WhatsApp Bot` notebook as the instructions (Joplin Data API). |
| `claude issue:<alias>:<n> [extra instructions]` | Implement GitHub issue `n` in the allowlisted `<alias>` workspace, then commit, PR, review and merge. See [Issue runs](#issue-runs). |
| `claude issue:<n> [extra instructions]` | The same, in the `CLAUDE_ISSUE_DEFAULT_ALIAS` workspace. |
| `claude:stop` | Kill the active run, or the active [scheduled job](#scheduled-jobs)'s command. Its "stopped" report lands in the outbox, and the next queued request starts. |
| `claude:queue` | List the requests waiting for the agent. |
| `claude:queue clear` | Drop every waiting request. |
| `claude:pause [<alias>] [2h] [reason]` | Pause by hand while you work in a repo yourself (duration `30m`, `2h`, `1d`, up to 7d; default 2h). With no alias, no new run starts anywhere: requests queue and the cron skips its ticks. With an alias, only issue runs there are refused (the cron moves on to the next workspace), and freeform runs are told to leave it alone. A run already going is not stopped. |
| `claude:resume [<alias>]` | End that pause early, or with no alias every pause, the [usage-limit pause](#usage-limit) included (e.g. after a plan upgrade). |
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

## Usage limit

When an agent run ends because the agent hit its usage limit (Claude: `You've hit your session
limit · resets 7am (Europe/London)`), the backend reports outcome `limited` with the reset time,
and the runner sets the **usage-limit pause** until then. The reset comes from the stream's
rejected rate-limit event when it carries one, else from the `resets …` text (`7am`, `7:30pm`,
`Oct 3, 7am`, in the zone named), plus 2 minutes, capped at 7 days. Text it can't read gives a 1h
pause, so the next run acts as a probe. The pause only ever extends.

While it holds, no new run starts: requests and scheduled jobs queue, and the cron skips its ticks
(tick outcome `limited`). `owner` gets one message per hit, e.g. `⏸ Usage limit hit: pausing agent
runs until 07:02 (resets 7am Europe/London). 2 requests queued.` (a run reporting to `owner`, like
the cron's, has its report in the same message). When the pause ends the queue and the cron pick up
silently. The run's history row has `outcome: limited`. `claude:status` and `npm run agent:status`
show the pause (`Paused: usage limit hit, until 07:02 (resets 7am Europe/London)`), and so do the
office snapshot's `pauses.limit` and the dashboard's Now and Office tabs.

To end it early (e.g. after a plan upgrade), send `claude:resume` with no alias or run `npm run
agent:resume`: they clear it along with any pauses by hand, and queued requests start (after
`agent:resume`, on the runner's next queue check, within 15s). If the limit
hasn't really lifted, the next run hits it again and sets a new pause.

An issue run the limit cuts short stops there. When the agent's own pass hits it, post-run commits
the leftover work as WIP on the issue branch and skips the review and the autofix; when the autofix
pass hits it, its leftover work is committed as WIP (not pushed) and nothing merges. No autofix pass
starts while the pause holds. The run's result is `limited` and its one report says so, e.g.
`⏸ #7 — Fix it: the agent hit its usage limit. Its leftover work is committed as WIP \`abc1234\` on
its branch. The cron resumes the issue after the reset.` A limited cron run isn't progress and
records no PR attempt, so the cron works the issue again after the reset.

A manual request (freeform, Joplin or issue) the limit stopped before it did any real work (its
first pass ended `limited` within 1 turn) goes back to the **head** of the queue, so it runs by
itself when the pause ends. `owner`'s message says so (`… Re-queued "fix the tests" at the head of
the queue. 1 request queued.`), and so does the run's report (in place of "run the issue again"). A
request the limit stopped mid-run (more than 1 turn, or in its autofix) is only reported, never
re-run: an issue run resumes from its WIP branch when sent again. Cron runs are never queued (the
cron retries on its own), and scheduled jobs aren't agent runs.

## Freeform runs' workspace

A freeform run's **inferred workspace** is the allowlisted workspace its first edit or command
works in: an edit of a file under the workspace's path, or a command run in it (the agent's shell
`cd`s there) or naming a path in it (`git -C`, `npm --prefix`, an absolute or `~/` path). Reads
and searches don't count. Paths are compared by realpath. Once set, it doesn't change for the rest
of the run.

The agent backend turns its tool calls into agent-neutral touches (`AgentTouch`; Claude's parsing is
`src/agentBackend/claudeToolTouch.js`), and `src/workspaceInference.js` matches them to the
allowlist. The workspace is recorded as `inferredWorkspace` on the lock record and the active-run
file, in the history row and the office snapshot, and shows in `claude:status` and
`claude:history` as `fix the login bug → whatsapp-bot`. Joplin runs don't infer one.

## Terminal status

```sh
npm run agent:status            # snapshot: cron, active runs, pause, spend, recent runs (--json)
npm run agent:watch             # the same, refreshed every 2s (agent:watch -- 5 for 5s)
npm run agent:history -- -n 20  # finished runs with model, tokens and cost (--json)
npm run agent:logs -- -f        # print or follow a run's log: [runId|prefix|latest] [-f]
npm run agent:pause -- chess-trainer 1h fixing lessons   # same as claude:pause, works while the runner is down
npm run agent:resume            # end every pause, the usage-limit pause too (agent:resume -- <alias> for one)
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
- **Skips**: the whole tick while the lock is held or agent-runner is paused (safe-restart, the
  general pause by hand or the usage-limit pause); issues that GitHub's
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

Commands the runner runs at a fixed UTC time, daily or (with `weekday` / `monthDay`) weekly or monthly, in place of crontab lines (the first are
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
    "at": "02:00",                     // time of day, HH:MM UTC
    "weekday": 1,                      // optional: only on this UTC weekday, 0–6 (0 = Sunday)
    "monthDay": 1,                     // optional, instead of weekday: only on this day of the month, 1–28
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
- **Usage file**: every job run gets `AGENT_RUNNER_USAGE_FILE`, a per-run path
  (`logs/agent-runs/<runId>.usage.jsonl`) that the job's `env` can't override. A job that calls an
  agent may append one JSON line per call:
  `{ "model": string|null, "turns": number, "costUsd": number|null, "tokens": { "input", "output", "cacheRead", "cacheCreate" } }`.
  When the job ends, whatever its outcome (failed, timeout and stopped included), the runner adds the
  lines into the job's history row as `model`, `turns`, `costUsd` and `tokens`, so they show in
  `claude:history`, `npm run agent:*` and the office. Turns, cost and token counts are summed, a
  missing number counts as 0, and the model is the one on the highest-cost line (the first line's if
  none has a cost). A malformed line is skipped with a warning in the runner log and never changes the
  job's outcome. A missing or empty file leaves the row as it is without usage.
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
**Issues**, **History** and **Office** tabs as plain text and tables (the plan is #17). The page is static files in
`dashboard/` with no build step, served by nginx, and it gets everything from the office feed. The
terms (Office, Cubicle, Queue room, …) are in [`CONTEXT.md`](CONTEXT.md).

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

### Issue scan

The office shows the work waiting in each repo (`src/issueScan.js`). The runner lists the open
issues of every allowlisted workspace's GitHub repo with `gh` on startup, every
`ISSUE_SCAN_INTERVAL_MS` (default 5 minutes) and right after each run ends, and caches the result
for the feed (`issues` above), so the page never talks to GitHub. Per repo: its `ready-for-agent`
issues split into **runnable**, **blocked** and **parked**, its `ready-for-human` issues, and how
many are `needs-triage` and `needs-info`.

Blocked and parked are the cron issue tracer's rules, from its own helpers: blocked is an open
native dependency (a failed lookup counts as blocked), and parked is an open agent PR whose current
state the cron has already attempted. The scan only reads the cron's PR attempts, and never changes
cron state. A repo whose scan fails keeps its last good data, marked `stale` (the failure is logged
on the runner, not sent to the page).

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
    "inferredWorkspace": null,         // a freeform run's workspace, once inferred (see below)
    "room": null, "jobName": null,     // a scheduled job's room and name, else null
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
    "workspaces": [ { "alias": "chess-trainer", "reason": "…", "pausedAt": "…", "until": "…" } ],
    "limit": null                      // usage-limit pause: {resetsAt, message} or null, e.g.
                                       // {"resetsAt": "…", "message": "usage limit hit, until 07:02 (resets 7am Europe/London)"}
  },
  "cron": {                            // null when the cron hasn't started
    "alive": true, "pid": 579608, "intervalMs": 600000,
    "lastTickStartedAt": "…", "lastTickEndedAt": "…", "outcome": { "kind": "no_eligible" },
    "nextTickAt": "…"                  // last tick start + interval; null before a tick or if dead
  },
  "lock": { "runId": "…", "kind": "issue", "trigger": "cron", "label": "…",
            "workspaceAlias": "bot", "inferredWorkspace": null, "issueNumber": 7,
            "room": null, "jobName": null, "startedAt": "…" },  // or null
  "history": [                         // the last 7 days, newest first
    { "runId": "…", "kind": "issue", "trigger": "cron", "label": "…", "workspaceAlias": "bot",
      "inferredWorkspace": null, "issueNumber": 7, "room": null, "jobName": null, "startedAt": "…", "endedAt": "…", "durationMs": 60000,
      "outcome": "success", "result": "merged", "prUrl": "https://github.com/…/pull/9",
      "model": "…", "turns": 3, "costUsd": 1.2, "tokens": 1700000 }
      // outcome: success | failed | timeout | stopped | spawn_error | limited (usage limit) | interrupted (by a restart)
      // result (issue runs): merged | pr_open | pushed | no_changes | timeout | limited | failed, else null
      // tokens: input + output + cache
  ],
  "spend": { "today": { "runs": 1, "costUsd": 2.33, "tokens": 2900000 },   // since local midnight
             "week":  { "runs": 24, "costUsd": 28.7, "tokens": 32300000 } },
  "workspaces": ["agent-runner", "bot", "chess-trainer"],  // allowlisted aliases, sorted
  "issues": {                          // the issue scan (below); null before its first scan ends
    "scannedAt": "…",                  // when the latest scan ended
    "repos": [                         // one per allowlisted workspace, in alias order
      { "alias": "bot", "repo": "owner/bot",   // repo: null if it has never scanned
        "scannedAt": "…",              // when this repo's data was read; null if never
        "stale": false,                // its latest scan failed: this is the last good data
        "runnable": [ { "number": 7, "title": "…", "url": "https://github.com/…/issues/7" } ],
        "blocked": [ /* ready-for-agent with an open native dependency (or a failed lookup) */ ],
        "parked": [ { "number": 5, "title": "…", "url": "…", "prUrl": "https://github.com/…/pull/9" } ],
        "readyForHuman": [ /* same shape as runnable */ ],
        "needsTriage": 2, "needsInfo": 0 }
    ]
  },
  "jobs": [                            // the scheduled jobs' config, in config order ([] if unreadable)
    { "name": "cleanup_agent", "room": "Research & Archives", "at": "02:00",
      "nextDueAt": "…" }               // when it next joins the queue
  ]
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
per allowlisted workspace (then one per scheduled-job room that isn't one, then a `<room> scripts` cubicle
for each room's plain-script jobs, its clerks'), and the side rooms: the Queue room (by the front
door), the Review room (the boss's office), the Freeform room and the Joplin room. In the wide
layout the side rooms are stacked down the left, a tiled corridor runs between them and the bullpen,
an aisle runs in front of each row of cubicles from the corridor across the bullpen (as many
cubicles to a row as fit, at least 4), and each side room has a doorway onto the corridor. In the narrow layout (a phone), the rooms are stacked with a tiled
corridor lane down their right edge: each side room's doorway is at the lane's end of its back
wall, and the bullpen and its aisles open straight onto the lane. It shows the office-level state:

- **Runner down:** the whole office is dark, apart from the EXIT sign.
- **General pause** (`claude:pause`): a "BACK IN 5" sign on the front door.
- **Workspace pause:** a "Do not disturb" sign on that cubicle.
- **Queue room:** the mail carrier at the desk, a countdown on the wall to the cron's next tick
  (hidden when the cron isn't running), and one letter on the mail cart per queued request (hover
  a letter for its label; a full cart piles the rest into its last slot).
- **Pending issues** (from the [issue scan](#issue-scan)): each runnable issue is a letter in its
  cubicle's in-tray, and a blocked one a letter with a padlock (the issue being worked at the desk
  is left out). A PR the cron has parked is a folder with a red clip on the boss's desk, labelled
  with its issue number, after the rooms' PR-open folders. A cubicle whose repo has `ready-for-human`
  issues has a sticky note on its monitor with how many. Hover any of them for the issues; a full
  tray or desk piles the rest into its last slot. Triage counts are only in the Issues tab.
- **Mail:** a new issue doesn't just appear in its tray: the mail carrier hands it out. When the
  scan turns up letters the page hasn't seen in a cubicle's tray before (not one coming back from
  the desk, and not any the page found when it opened), the carrier walks a round from the Queue
  room with a bundle, stopping at each of those cubicles in turn to drop its letters in the tray,
  and back. Runs and rounds queue for the carrier in the order they came in: a run that comes in
  mid-round waits until they're back.

Pauses clear on the page as soon as they run out, without waiting for the next snapshot.

A live run plays out on the floor:

- **Delivery:** the mail carrier takes the run from the Queue room to its room: an interoffice envelope
  for a cron run, or the Queue room's phone rings first for a manual (WhatsApp) one. They walk out
  of the Queue room's doorway and along the corridor (or the lane) and aisles to the desk (into a
  cubicle by its open front, into the Freeform or Joplin room by its doorway), and back, at a steady
  pace, so a far desk takes longer. Every walk is timed on the wide office at its narrowest, so
  resizing the page mid-walk (wide ↔ narrow too) puts the walker the same fraction along the new
  route. A page opened mid-run doesn't replay it.
- **Rooms:** an issue run is worked in its workspace's cubicle, a freeform run in the Freeform
  room, a Joplin run in the Joplin room, and a scheduled job at its own desk in the room its config
  names. When a freeform run's workspace is inferred (below), its worker picks up their papers and
  walks from the Freeform room to that cubicle (once the mail carrier has handed the run over): out
  of its doorway, along the corridor and aisle, and round the end of the desk to their seat. Its
  outcome shows there when it ends.
- **Scheduled jobs:** each job's `room` label gets a cubicle (a label matching a workspace's alias or
  department sign is that workspace's cubicle), with a desk per job and its own worker: a janitor
  with a mop for a `cleanup` job, an analyst with a chart easel for an `insight` or `report` one, else
  a clerk in a green visor. A due job is delivered by envelope, and waits on the mail cart like any
  request. A job has no turns or tokens: its pile grows with elapsed time, and its speech bubble is
  the latest line of its output (from the live log). The Now tab shows its elapsed time and tails its
  masked output, and the Office tab lists each job's next due time.
- **Agent phase:** the worker types, the paper pile on the desk grows with turns and elapsed time
  (to a cap), and a speech bubble shows the last activity, shortened (hover the worker for all of it).
- **Subagents:** each subagent the agent spawns is played by a colleague: the resident of the
  nearest workspace cubicle (left first, skipping Do Not Disturb) gets up and walks over to the
  run's desk, or, when no resident can come (at night, say), a temp in a visitor's lanyard comes in
  from the Queue room. They stand in front of the desk facing the worker, with a tag saying which
  tool their subagent is using (`BASH`, `READ`, `WRITE` while it writes), and walk back once it's
  done (or the run moves on to post-run). Up to 4 stand at a desk. Hover one for what it was asked
  and is doing. `claude:status` lists the subagents too.
- **Post-run** (issue runs): the boss walks over (out of the Review room's doorway, along the
  corridor and aisle, and round the nearer end of the desk) and, once there, reads over the worker's
  shoulder during the review (from the start of post-run: the snapshot can't tell the review from
  the commit), the worker scribbles frantically during the autofix, and the boss walks back the same
  way and sits down when the run ends. Everyone walks at the same pace, facing the way they go.
- **Doors:** each side room's doorway has a door that swings open as someone walking comes near
  and shuts behind them once they've gone by: seen from above in the wide layout, its leaf swinging
  into the room, and face-on in the back wall in the narrow one. The front door never opens.

Between runs the office has a life of its own (`ambient.js`), on the viewer's clock and the same on
every page:

- **Residents:** each workspace cubicle has its own resident at the desk through the morning, day and
  evening. They idle (sitting still, sipping coffee, leaning back, looking round, stretching, dozing
  off, far more in a cubicle with no run for 3 days), flick through their in-tray while it has
  letters, peer at the cubicle next door while a run is worked there, and cheer a merge in their
  cubicle (or clap one next door) for a few seconds. When a run's worker arrives at the desk, they
  take the resident's seat. A resident never types, grows a pile or speaks in a bubble, so a real run
  still stands out.
- **Looks:** every worker has their own look (`looks.js`): skin, hair colour and style, shirt,
  tie or open collar, glasses or a beard, worked out from who they are (a workspace's resident, a
  job's worker, the Freeform or Joplin room's), so it's the same on every page and across reloads,
  and no two in the office share both shirt and hair colour. A workspace's resident and the worker
  on its runs are the same person.
- **Breaks:** now and then a resident walks to the Freeform room's water cooler (and back with a
  mug), the Joplin room's bookshelf, or a neighbour's cubicle for a chat, along the corridor and
  aisles, opening the doors on the way. At most a couple at once, never someone on Do Not Disturb.
- **The boss** paces behind their desk now and then while PRs are parked.
- **Day and night:** the windows show the sky for the time of day (morning, day, evening, stars at
  night). From 22:00 to 07:00 the residents are home, a night janitor mops up and down the aisles,
  and the lights are down everywhere but the Queue and Review rooms, the active run's room, and rooms
  with a scheduled job's worker (or a run's resting worker) at their desk.

When a run ends, its room shows how it went, and keeps showing it until the next run there starts.
It comes from the room's latest history row in the feed, so it survives a page reload and a runner
restart (for rooms with a run in the feed's 7 days):

| Outcome | Scene |
|---|---|
| Merged (and a freeform, Joplin or job run that succeeded) | A big stamp, and the papers go to the out tray. A run under 5 minutes gets just a quick stamp |
| PR open, or pushed without a PR | A folder on the boss's desk, labelled with the room |
| Failed (a job's non-zero exit too), or couldn't start | An injured worker (bandage, ice pack) |
| Timed out | Asleep at the desk, Zzz |
| Stopped (`claude:stop`, the autofix pass's too) | The worker has gone home, and that room is dark |
| Interrupted by a restart | A drunk, dizzy worker |
| No changes | A shrug, and a tumbleweed rolls by now and then |

Hovering a room (a cubicle, the Freeform room or the Joplin room) shows its last run's outcome, when it ended,
and its PR. The mapping (`restingState` in `scene.js`) falls back to showing nothing for an outcome
it doesn't know.

The **Issues** tab lists each repo's pending issues, with links to the issues and the parked PRs,
the triage counts, and when it was scanned (in red when that data is stale).

Clicking a cubicle (or its worker) filters the Issues and History tabs to that workspace, and outlines the
cubicle. Clicking it again, or anywhere else on the floor, clears the filter.

The scene is drawn at a small internal resolution (360px tall, 560–720px wide) and scaled up by a
whole number with smoothing off, so the pixels stay crisp. On a wide screen it takes about 65% of
the width with the panel on the right; under 900px the panel goes below it, and under 560px the
rooms stack vertically (the Queue room first).

Each cubicle's sign shows its repo's alias. The cubicles' order comes from
[`dashboard/office.json`](dashboard/office.json):

```json
{ "cubicles": [{ "alias": "agent-runner" }, { "alias": "bot" }] }
```

Listed aliases come first, in that order. Allowlisted aliases it doesn't list follow, and listed
aliases that aren't allowlisted are ignored. An entry can give a `name` to show on the sign instead
of the alias. About 10 characters fit a sign at every size; a longer one is cut short on the
narrowest wide layouts.

The code is split so the rules are testable and the art is replaceable: `scene.js` is the pure
scene reducer (snapshot + previous scene → scene, tested: room placement, phases, pile growth,
when each animation starts, and each room's last outcome), `layout.js` places the rooms, corridors, aisles, cubicles
and desks, builds the walk graph and hit-tests clicks (tested), `walkers.js` works out who walks the floor
and where at a given time, routing over the walk graph (tested), `ambient.js` decides the office's
ambient life (who's in, their poses, the breaks, the time of day; tested), `looks.js` gives everyone their
own look (tested), `sprites.js` draws every sprite procedurally (swap it for
sprite sheets later), and `officeView.js` draws a scene on a layout with the sprites, tweening the animations from the
times the scene gives.

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
| `agent-runner:usage-limit` | string (JSON) | The usage-limit pause: `{until, note, timeZone, since}`, TTL'd to end with it. Set only by the runner, and only ever extended; `claude:resume` / `agent:resume` with no alias delete it. |
| `agent-runner:manual-pause` | hash | Pauses set by hand: `all` or a workspace alias → `{scope, reason, pausedAt, until}`. Expired fields are ignored and deleted on read. |
| `agent-runner:cron:state` | string (JSON) | The cron's last tick (`pid`, `intervalMs`, times, outcome), for the status views. |
| `agent-runner:cron:last-started` | hash | `owner/repo` → the last issue the cron made progress on there. |
| `agent-runner:cron:pr-attempts` | hash | `owner/repo#n` → the PR state (`headSha:baseSha`) the cron last worked. Not written when an approved PR's merge failed only on a network error, so the next tick works it again. |
| `agent-runner:state-changed` | pub/sub channel | The CLIs and safe-restart publish the key of each state write they make, so the runner's office feed pushes. |
| `agent-runner:cron:park-notices` | hash | `owner/repo#n` → the parked PR state the owner was last told about. |
| `agent-runner:cron:no-changes` | hash | `owner/repo#n` → consecutive runs that made no changes; at 3 the cron parks the issue. |
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
  autofix pass; a run a restart cut off gets an `outcome: interrupted` row on startup).

## Tests

```sh
npm test            # node:test with injected fakes; the Redis contract test uses DB 15 if Redis is up
npm run typecheck   # tsc --checkJs
```
