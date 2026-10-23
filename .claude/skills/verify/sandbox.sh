#!/usr/bin/env bash
# A sandboxed second agent-runner: a copy of this checkout's src/ and bin/, its own port, Redis DB
# and HOME, an env built from scratch, and stub claude/gh/pm2 binaries. See SKILL.md.
#
#   sandbox.sh up       start it in the background and wait until /status answers
#   sandbox.sh doctor   is the running sandbox ours, healthy and isolated?
#   sandbox.sh check    drive status, office feed, freeform (stub agent) and one scheduled job
#   sandbox.sh down     stop what up started, empty its Redis DB, delete scratch, keep evidence/
#   sandbox.sh smoke    up, check, down (down runs on any exit)
set -euo pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SKILL_DIR" rev-parse --show-toplevel)
DIR=${AGENT_RUNNER_VERIFY_DIR:-/tmp/agent-runner-verify}
DB=${AGENT_RUNNER_VERIFY_DB:-14}
LIVE_PORT=3790
LIVE_REDIS=redis://127.0.0.1:6379
LIVE_LOGS=${AGENT_RUNNER_LIVE_LOGS:-$HOME/Projects/agent-runner/logs/agent-runs}
STATE=$DIR/state.env
EVIDENCE=$DIR/evidence
# up refuses a $DIR that has files but not this marker, so a wrong AGENT_RUNNER_VERIFY_DIR is never emptied
OWNED=$DIR/.agent-runner-verify
MARK=agent-runner-verify-sandbox

die() { echo "sandbox: $*" >&2; exit 1; }
say() { echo "sandbox: $*"; }
rcli() { redis-cli -n "$DB" "$@"; }
# After a failed SELECT (say DB 99 of 16), redis-cli prints an error and runs the command on DB 0 anyway.
db_ok() { [[ $(redis-cli -n "$DB" PING 2>&1) == PONG ]]; }

valid_db() { [[ $DB =~ ^[1-9][0-9]*$ ]] || die "the Redis DB must be a number from 1 up, never 0 (production); got '$DB'"; }
valid_db
[[ $DIR =~ ^/[A-Za-z0-9/_.-]+$ ]] || die "AGENT_RUNNER_VERIFY_DIR must be an absolute path of letters, digits and / _ . -"

# Sets DB (the DB up used, whatever AGENT_RUNNER_VERIFY_DB says now), NONCE, JOB, PID, PORT and JOB_AT.
load_state() {
  [[ -f $STATE ]] || die "no sandbox state at $STATE (run up first)"
  # shellcheck source=/dev/null
  . "$STATE"
  valid_db
}

owned() { [[ -f $OWNED ]] || die "$DIR was not made by sandbox.sh; refusing to delete anything in it"; }

ours() { [[ -n ${PID:-} ]] && [[ $(tr '\0' ' ' 2>/dev/null </proc/"$PID"/cmdline) == *"$DIR/app/src/main.ts"* ]]; }

# Every process the sandbox started (the runner, its agents and jobs) inherits the marker env var.
sandbox_pids() {
  local env p
  for env in /proc/[0-9]*/environ; do
    p=${env#/proc/}; p=${p%/environ}
    [[ $p == "$$" ]] && continue
    tr '\0' '\n' 2>/dev/null <"$env" | grep -qxF "AGENT_RUNNER_VERIFY_SANDBOX=$DIR" && echo "$p"
  done
  return 0
}

stub() { printf '%s\n' '#!/bin/sh' "$2" >"$DIR/stubs/$1"; chmod +x "$DIR/stubs/$1"; }

preflight() {
  [[ -f $STATE ]] && die "$STATE exists, so a sandbox is running or was not cleaned up; run down first"
  if [[ -d $DIR && -n $(ls -A "$DIR") ]]; then owned; fi
  local p=$DIR
  while [[ ! -e $p ]]; do p=$(dirname "$p"); done
  ! git -C "$p" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$DIR is inside a git work tree; pick a scratch AGENT_RUNNER_VERIFY_DIR"
  db_ok || die "cannot use Redis DB $DB: $(redis-cli -n "$DB" PING 2>&1 | head -1)"
  [[ -z $(rcli --scan --pattern '*' | head -1) ]] || die "Redis DB $DB is not empty; run down, or pick another AGENT_RUNNER_VERIFY_DB"
}

start() {
  mkdir -p "$DIR"
  : >"$OWNED"
  # a fresh name per up, so production's own history can't match it and a second check can't pass on the first
  NONCE=$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')
  JOB=verify_echo_$NONCE
  printf 'DB=%s\nNONCE=%s\nJOB=%s\n' "$DB" "$NONCE" "$JOB" >"$STATE"
  rm -rf "$DIR/app" "$DIR/home" "$DIR/workspace" "$DIR/stubs" "$EVIDENCE"
  mkdir -p "$DIR/app" "$DIR/home/.claude/projects" "$DIR/workspace" "$DIR/stubs" "$EVIDENCE"
  # A copy, so REPO_ROOT (logs/agent-runs, .env, scheduled-jobs.json) is the sandbox's, never a real checkout's.
  cp -a "$REPO/src" "$REPO/bin" "$REPO/package.json" "$DIR/app/"
  ln -s "$REPO/node_modules" "$DIR/app/node_modules"
  echo '{}' >"$DIR/workspaces.json"
  : >"$EVIDENCE/stub-calls.log"

  stub claude "echo \"claude \$*\" >>'$EVIDENCE/stub-calls.log'
cat <<'EOF'
{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"verify-stub-session\",\"model\":\"stub\"}
{\"type\":\"assistant\",\"session_id\":\"verify-stub-session\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"stub agent ran\"}]}}
{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"verify stub reply $NONCE\",\"num_turns\":1,\"total_cost_usd\":0,\"session_id\":\"verify-stub-session\"}
EOF"
  stub gh "echo \"gh \$*\" >>'$EVIDENCE/stub-calls.log'; echo 'sandbox: gh is stubbed' >&2; exit 1"
  stub pm2 "echo \"pm2 \$*\" >>'$EVIDENCE/stub-calls.log'; echo 'sandbox: pm2 is stubbed' >&2; exit 1"
  # augmentedPathEnv puts ~/.local/bin first for agents and jobs
  mkdir -p "$DIR/home/.local"
  ln -s "$DIR/stubs" "$DIR/home/.local/bin"

  # due in two minutes (UTC), so the scheduler adopts it as not yet run today and fires it once
  local at
  at=$(date -u -d '+2 min' +%H:%M)
  cat >"$DIR/jobs.json" <<EOF
[{"name":"$JOB","room":"verify","cwd":"$DIR/workspace","command":"echo verify-job-ran","at":"$at","logFile":"$EVIDENCE/job.log"}]
EOF

  local port node
  port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  ((port != LIVE_PORT)) || die "picked the live port"
  node=$(command -v node)

  # env -i: nothing from this shell leaks in (CLAUDE*, pm_exec_path, AI_AGENT, GIT_EDITOR, ...). The
  # copy has no .env, and every config value the runner reads that could reach something real is set.
  (
    cd "$DIR/app"
    env -i \
      AGENT_RUNNER_VERIFY_SANDBOX="$DIR" \
      HOME="$DIR/home" \
      PATH="$DIR/stubs:$(dirname "$node"):/usr/bin:/bin" \
      LANG=C.UTF-8 \
      AGENT_RUNNER_PORT="$port" \
      AGENT_RUNNER_PM2_NAME="$MARK" \
      REDIS_URL="$LIVE_REDIS/$DB" \
      AGENT_WORKSPACE="$DIR/workspace" \
      CLAUDE_AGENT_BIN="$DIR/stubs/claude" \
      GH_BIN="$DIR/stubs/gh" \
      CLAUDE_WORKSPACE_MAP= \
      CLAUDE_WORKSPACE_MAP_FILE="$DIR/workspaces.json" \
      CLAUDE_ISSUE_DEFAULT_ALIAS= \
      CRON_SECONDARY_WORKSPACE_ALIASES=none \
      CRON_ISSUE_TRACER_DISABLE=1 \
      SESSION_WATCH_DISABLE=1 \
      CLAUDE_PROJECTS_DIR="$DIR/home/.claude/projects" \
      ISSUE_SCAN_INTERVAL_MS=86400000 \
      SCHEDULED_JOBS_FILE="$DIR/jobs.json" \
      JOPLIN_API_URL=http://127.0.0.1:9 \
      JOPLIN_API_TOKEN= \
      OPENAI_API_KEY= DEEPINFRA_API_KEY= GMAIL_EMAIL= GMAIL_PASSWORD= \
      setsid "$node" --no-deprecation "$DIR/app/src/main.ts" >"$EVIDENCE/server.log" 2>&1 </dev/null &
    echo "PID=$!" >>"$STATE"
  )
  printf 'PORT=%s\nJOB_AT=%s\n' "$port" "$at" >>"$STATE"
  . "$STATE"

  for _ in $(seq 60); do
    kill -0 "$PID" 2>/dev/null || { cat "$EVIDENCE/server.log" >&2; die "the runner exited during startup; run down"; }
    # until setsid has exec'd node, the pid's command line is still the shell's
    ours && curl -sf "127.0.0.1:$PORT/status" >/dev/null && { say "up: pid $PID, http://127.0.0.1:$PORT, Redis DB $DB, job $JOB at $at UTC, dir $DIR"; return; }
    sleep 0.5
  done
  die "no /status answer within 30s; see $EVIDENCE/server.log, then run down"
}

doctor() {
  load_state
  local bad=0
  ours && say "ok: pid $PID runs $DIR/app/src/main.ts" || { say "FAIL: pid ${PID:-?} is not the sandbox runner"; bad=1; }
  [[ $(ss -ltnpH "sport = :$PORT" 2>/dev/null) == *"pid=$PID,"* ]] && say "ok: port $PORT belongs to pid $PID" || { say "FAIL: port $PORT is not held by pid $PID"; bad=1; }
  curl -sf "127.0.0.1:$PORT/status" >/dev/null && say "ok: /status answers" || { say "FAIL: /status does not answer"; bad=1; }
  local env
  env=$(tr '\0' '\n' 2>/dev/null </proc/"$PID"/environ || true)
  grep -qxF "REDIS_URL=$LIVE_REDIS/$DB" <<<"$env" && say "ok: Redis DB $DB" || { say "FAIL: REDIS_URL is not DB $DB"; bad=1; }
  if grep -qE '^(pm_exec_path|CLAUDECODE|CLAUDE_CODE_[A-Z_]*|AI_AGENT)=' <<<"$env"; then say "FAIL: harness or PM2 variables leaked into the runner"; bad=1; else say "ok: no harness or PM2 variables"; fi
  grep -q "cron issue tracer disabled" "$EVIDENCE/server.log" && say "ok: cron off" || { say "FAIL: cron is not disabled"; bad=1; }
  return $bad
}

# Production's state the sandbox must never touch: its outbox and history must not mention this
# sandbox's nonce, and the job's last-fired field must not appear in DB 0.
live_untouched() {
  local leaks=0
  if redis-cli -n 0 XRANGE agent-runner:outbox - + | grep -qF "$NONCE"; then say "FAIL: production outbox mentions the sandbox"; leaks=1; fi
  [[ $(redis-cli -n 0 HEXISTS agent-runner:jobs:last-fired "$JOB") == 0 ]] || { say "FAIL: production jobs:last-fired has $JOB"; leaks=1; }
  if grep -qF "$NONCE" "$LIVE_LOGS/runs.jsonl" 2>/dev/null; then say "FAIL: production history mentions the sandbox"; leaks=1; fi
  return $leaks
}

command_reply() {
  curl -sf -X POST "127.0.0.1:$PORT/command" -H 'content-type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({text: process.argv[1], replyTo: "verify"}))' "$1")" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reply))'
}

outbox_text() { rcli XRANGE agent-runner:outbox - +; }

wait_for() { # seconds, description, command...
  local secs=$1 what=$2; shift 2
  for _ in $(seq $((secs * 2))); do "$@" && return 0; sleep 0.5; done
  say "FAIL: timed out after ${secs}s waiting for $what"; return 1
}

check() {
  load_state
  [[ ! -e $EVIDENCE/.check-started ]] || die "check already ran on this sandbox, so it would pass on that run's results; run down and up"
  : >"$EVIDENCE/.check-started"
  local fail=0 out
  live_untouched >/dev/null || die "production already mentions the sandbox before the check; inspect it by hand"
  curl -sf "127.0.0.1:$LIVE_PORT/status" >"$EVIDENCE/live-status-before.json" || true

  out=$(command_reply claude:status) || { say "FAIL: POST /command claude:status"; out=; }
  echo "$out" >"$EVIDENCE/claude-status.txt"
  [[ $out == *"Agent: idle"* && $out == *"Paused: no"* ]] && say "ok: claude:status replied ($(wc -l <<<"$out") lines)" || { say "FAIL: claude:status reply: $out"; fail=1; }
  curl -sf "127.0.0.1:$PORT/status" | tee "$EVIDENCE/status.json" | grep -q '"busy":false' && say "ok: /status $(cat "$EVIDENCE/status.json")" || { say "FAIL: /status"; fail=1; }

  timeout 4 curl -sN "127.0.0.1:$PORT/office/feed" >"$EVIDENCE/feed.txt" || true
  if grep -A1 -m1 -x 'event: snapshot' "$EVIDENCE/feed.txt" | sed -n 's/^data: //p' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);process.exit(v.version===1&&v.jobs?.some(j=>j.name===process.argv[1])?0:1)})' "$JOB"; then
    say "ok: office feed sent a version 1 snapshot listing $JOB"
  else say "FAIL: office feed: $(head -c 300 "$EVIDENCE/feed.txt")"; fail=1; fi

  out=$(command_reply 'claude say hello to the verify sandbox') || { say "FAIL: POST /command freeform"; fail=1; }
  echo "$out" >"$EVIDENCE/freeform-reply.txt"
  say "freeform: $out"
  if wait_for 60 "the stub agent's reply in the outbox" bash -c "redis-cli -n $DB XRANGE agent-runner:outbox - + | grep -qF 'verify stub reply $NONCE'" &&
    grep -q '^claude -p' "$EVIDENCE/stub-calls.log"; then
    say "ok: freeform ran the stub agent and its reply reached the sandbox outbox"
  else fail=1; fi

  say "waiting for $JOB (due $JOB_AT UTC; the scheduler ticks every 30s)"
  if wait_for 240 "$JOB in claude:history" bash -c "grep -q verify-job-ran '$EVIDENCE/job.log' 2>/dev/null && [[ \$(redis-cli -n $DB HGET agent-runner:jobs:last-fired $JOB) == \$(date -u +%F) ]]"; then
    wait_for 30 "$JOB to finish" bash -c "curl -sf 127.0.0.1:$PORT/status | grep -q '\"busy\":false'" || fail=1
    out=$(command_reply 'claude:history 5') || { say "FAIL: POST /command claude:history"; out=; }
    echo "$out" >"$EVIDENCE/claude-history.txt"
    [[ $out == *"scheduled job $JOB"* ]] && say "ok: $JOB ran (job.log) and is in claude:history" || { say "FAIL: claude:history lacks $JOB: $out"; fail=1; }
  else fail=1; fi
  outbox_text >"$EVIDENCE/outbox.txt"

  if live_untouched; then say "ok: production outbox, history and jobs:last-fired do not mention the sandbox"; else fail=1; fi
  curl -sf "127.0.0.1:$LIVE_PORT/status" >"$EVIDENCE/live-status-after.json" || true
  grep -qE '^(gh|pm2) ' "$EVIDENCE/stub-calls.log" && say "note: the runner called stubbed gh or pm2 (see stub-calls.log)"
  ((fail == 0)) && say "PASS (evidence in $EVIDENCE)" || say "FAILED (evidence in $EVIDENCE)"
  return $fail
}

down() {
  [[ -d $DIR ]] || { say "nothing to do: no $DIR"; return 0; }
  owned
  [[ -f $STATE ]] || { rm -rf "$DIR/app" "$DIR/home" "$DIR/workspace" "$DIR/stubs" "$DIR/jobs.json" "$DIR/workspaces.json"; say "no state file, so no Redis DB to empty; evidence kept in $EVIDENCE"; return 0; }
  load_state
  if [[ -n ${PID:-} ]]; then
    if ours; then
      kill -TERM "$PID" 2>/dev/null || true
      for _ in $(seq 20); do ours || break; sleep 0.5; done
      ours && { kill -KILL "$PID" 2>/dev/null || true; }
    fi
  fi
  local left
  left=$(sandbox_pids)
  [[ -n $left ]] && { say "killing leftover sandbox processes: $(tr '\n' ' ' <<<"$left")"; kill -KILL $left 2>/dev/null || true; }
  if db_ok; then
    rcli --scan --pattern 'agent-runner:*' | xargs -r redis-cli -n "$DB" DEL >/dev/null || say "could not empty Redis DB $DB; delete its agent-runner:* keys by hand"
  else say "cannot use Redis DB $DB, so it was not emptied"; fi
  rm -rf "$DIR/app" "$DIR/home" "$DIR/workspace" "$DIR/stubs" "$DIR/jobs.json" "$DIR/workspaces.json" "$STATE"
  say "down; evidence kept in $EVIDENCE"
}

up() { preflight; start; }

smoke() {
  preflight
  trap down EXIT
  start
  doctor
  check
}

case ${1:-} in
  up | doctor | check | down | smoke) "$1" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
