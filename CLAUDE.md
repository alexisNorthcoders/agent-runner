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
merge, in `src/issuePipeline/`), `claude:stop`, `claude:restart` / `npm run safe-restart`, scheduled jobs (`src/scheduledJobs.ts`, daily commands in place of crontab lines),
`claude:status` / `claude:history` and the `npm run agent:*` CLIs, the Redis single-flight lock, run queue,
pause flag and manual pauses (`claude:pause` / `npm run agent:pause`, general or per workspace), startup recovery (with a WIP commit for issue runs), and the cron issue tracer
(`src/cronTracer.ts`, over `runner.startIssueRun`, with its state in Redis), and the office
dashboard's feed (`GET /office/feed`, SSE, pushed from `src/stateChanges.ts`, with the active run's masked live log from `src/logTail.ts`) and plain panel
(`dashboard/`), with each repo's pending issues from the issue scan (`src/issueScan.ts`). Layout, Redis keys and the office snapshot shape are in `README.md`; dashboard terms
are in `GLOSSARY.md`.

## Conventions

- Node ESM, no build. Node runs `.ts` directly. The code is moving from JSDoc-checked `.js` to strict
  `.ts`: `npm run typecheck` runs strict `tsc` over `.ts`, strict checkJs over `dashboard/`
  (`tsconfig.dashboard.json`; nginx serves it raw, so it stays JS and reads its wire types from
  `src/officeWire.ts` only), and a loose checkJs pass over the remaining `.js` (`jsconfig.json`).
  `npm test` runs the typecheck, then the `node:test` tests with injected fakes.
- Entry modules (`src/main.js`, `bin/*`) start work only inside `if (import.meta.main)`;
  `test/entryGuards.test.ts` checks that importing one does nothing. PM2 loads `src/main.js` with
  `import()`, where `import.meta.main` is false, so its guard also accepts an exact `pm_exec_path`.
  Agent runs inherit `pm_exec_path` from PM2, so inside a run in the live checkout, importing
  `src/main.js` starts a second runner. Never import or run an entry module to check that it loads.
- Modules say "agent", not "claude". Claude-specific code stays in `src/agentBackend/claude.ts`
  (and its stream parser). User-facing commands stay `claude*`.
- Redis access goes through the `Store` interface (`src/redisStore.ts`). Tests use
  `test/helpers/memoryStore.ts`, kept honest by `test/store.contract.test.ts`.

## Agent skills

### Issue tracker

GitHub Issues (alexisNorthcoders/agent-runner), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (root `GLOSSARY.md` + `docs/adr/`). See `docs/agents/domain.md`.
