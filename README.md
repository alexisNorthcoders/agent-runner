# agent-runner

A standalone PM2 service on the Pi that runs headless coding-agent sessions (Claude Code CLI) for
the WhatsApp bot. The bot forwards `claude…` messages over localhost HTTP, and the runner reports
back through a Redis Stream outbox that the bot delivers. Design:
WhatsappBot `docs/adr/0001-agent-runner-out-of-process.md`.

Built so far: freeform runs, `joplin:` runs, the GitHub issue pipeline (`claude issue:…`),
`claude:stop`, `claude:restart`, status/history (`claude:status`, `claude:history`,
`npm run agent:*`), and the cron issue tracer.

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
| `claude issue:<alias>:<n> [extra instructions]` | Implement GitHub issue `n` in the allowlisted `<alias>` workspace, then commit, PR, review and merge. See [Issue runs](#issue-runs). |
| `claude issue:<n> [extra instructions]` | The same, in the `CLAUDE_ISSUE_DEFAULT_ALIAS` workspace. |
| `claude:stop` | Kill the active run. Its "stopped" report lands in the outbox. |
| `claude:restart` | Run safe-restart in the background, then report to the outbox. |
| `claude:status` | Active run (with orphaned/stale warnings), pause, last cron tick, today's spend, last 3 runs. |
| `claude:history [n]` | The last `n` finished runs (default 10, max 30) with outcome, duration, cost and tokens. |

There is one run at a time and no queue: a request while busy is rejected. Status and history
replies are a single compact message, with no log paths or excerpts.

## Terminal status

```sh
npm run agent:status            # snapshot: cron, active runs, pause, spend, recent runs (--json)
npm run agent:watch             # the same, refreshed every 2s (agent:watch -- 5 for 5s)
npm run agent:history -- -n 20  # finished runs with model, tokens and cost (--json)
npm run agent:logs -- -f        # print or follow a run's log: [runId|prefix|latest] [-f]
```

These read `logs/agent-runs/` directly (plus the pause flag, lock and cron state from Redis), so they work while the
runner is down. An active run's `state` is `running`, `orphaned` (the runner died but the agent
process is still going, so nobody will report its result) or `stale` (both are gone). The runner
deletes stale active files on startup and keeps orphaned ones.

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
| `agent-runner:paused` | string (JSON) | Pause flag set by safe-restart. It is TTL'd, and only its setter (by token) clears it. The cron skips its ticks while it's set. |
| `agent-runner:cron:state` | string (JSON) | The cron's last tick (`pid`, `intervalMs`, times, outcome), for the status views. |
| `agent-runner:cron:last-started` | hash | `owner/repo` → the last issue the cron made progress on there. |
| `agent-runner:cron:pr-attempts` | hash | `owner/repo#n` → the PR state (`headSha:baseSha`) the cron last worked. Not written when an approved PR's merge failed only on a network error, so the next tick works it again. |
| `agent-runner:cron:park-notices` | hash | `owner/repo#n` → the parked PR state the owner was last told about. |

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
- `src/agentBackend/`: the `AgentBackend` seam. `claude.js` holds everything Claude-specific (CLI
  flags, stream-json parsing, cost/tokens, `/implement`).
- `src/runLock.js`, `src/pauseFlag.js`, `src/outbox.js`, `src/cronState.js`: Redis state over
  `src/redisStore.js`.
- `src/cronTracer.js`: the cron issue tracer (picking, parking, progress), over `runner.startIssueRun`.
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
- `logs/agent-runs/`: one `<runId>.log` per run (plus `<runId>-autofix.log`), `active/<runId>.json`
  per in-flight run (live progress), `runs.jsonl` history (an issue run's `costUsd` includes its
  autofix pass).

## Tests

```sh
npm test            # node:test with injected fakes; the Redis contract test uses DB 15 if Redis is up
npm run typecheck   # tsc --checkJs
```
