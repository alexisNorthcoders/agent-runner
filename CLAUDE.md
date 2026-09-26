# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Never restart agent-runner directly

Agent runs are child processes of the `agent-runner` PM2 app. **Never run `pm2 restart|reload|stop|delete agent-runner`**
(or `killall node`). Use `npm run safe-restart`, which refuses while a run is active. If you are
running inside agent-runner, your own run is the active one, so safe-restart will refuse. Say in
your summary that a restart is needed, and the user will send `claude:restart`. Restarting other
PM2 apps (including `whatsapp`) is fine.

## What this is

`agent-runner` is a standalone PM2 service on the Raspberry Pi that runs headless coding-agent
sessions (Claude CLI today, behind an agent-neutral `AgentBackend` seam). It was split out of the
WhatsApp bot (`alexisNorthcoders/WhatsappBot`). The bot is a thin front end that forwards `claude…`
messages over localhost HTTP (`POST /command`, `GET /status` on 127.0.0.1) and delivers this
service's Redis outbox (`agent-runner:outbox` stream). The design record is WhatsappBot
`docs/adr/0001-agent-runner-out-of-process.md`, and the work is tracked in WhatsappBot #102.

Built so far: freeform runs, `claude joplin:<note>`, the GitHub issue pipeline
(`claude issue:<alias>:<n>`: fetch → branch in place → agent → commit → PR → review → autofix →
merge, in `src/issuePipeline/`), `claude:stop`, `claude:restart` / `npm run safe-restart`, scheduled jobs (`src/scheduledJobs.js`, daily commands in place of crontab lines),
`claude:status` / `claude:history` and the `npm run agent:*` CLIs, the Redis single-flight lock, run queue,
pause flag and manual pauses (`claude:pause` / `npm run agent:pause`, general or per workspace), startup recovery (with a WIP commit for issue runs), and the cron issue tracer
(`src/cronTracer.js`, over `runner.startIssueRun`, with its state in Redis), and the office
dashboard's feed (`GET /office/feed`, SSE, pushed from `src/stateChanges.js`, with the active run's masked live log from `src/logTail.js`) and plain panel
(`dashboard/`). Layout, Redis keys and the office snapshot shape are in `README.md`; dashboard terms
are in `CONTEXT.md`.

## Conventions

- Node ESM, no build. Tests are `node:test` with injected fakes (`npm test`), and `npm run typecheck`
  runs `tsc --checkJs` over JSDoc types. Run both before committing.
- Modules say "agent", not "claude". Claude-specific code stays in `src/agentBackend/claude.js`
  (and its stream parser). User-facing commands stay `claude*`.
- Redis access goes through the `Store` interface (`src/redisStore.js`). Tests use
  `test/helpers/memoryStore.js`, kept honest by `test/store.contract.test.js`.

## Agent skills

### Issue tracker

GitHub Issues (alexisNorthcoders/agent-runner), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (root `CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
