# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`agent-runner` is a standalone PM2 service on the Raspberry Pi that runs headless coding-agent
sessions (Claude CLI today, behind an agent-neutral `AgentBackend` seam): freeform runs, the
GitHub issue pipeline (fetch → branch → agent → commit → PR → review → merge) and a cron issue
tracer. It was split out of the WhatsApp bot (`alexisNorthcoders/WhatsappBot`). The bot is a thin
front end that forwards `claude…` messages over localhost HTTP and delivers this service's Redis
outbox. The design record is WhatsappBot `docs/adr/0001-agent-runner-out-of-process.md`, and the
work is tracked in WhatsappBot #102.

The code is still being built (see the open issues here). Update this file as the structure lands.

## Agent skills

### Issue tracker

GitHub Issues (alexisNorthcoders/agent-runner), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (root `CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
