# Office feed

The office dashboard (`dashboard/`, served by nginx at `/office/`) reads `GET /office/feed`, a server-sent event stream. It sends a full snapshot on connect and again after every state change, and `event: log` lines from the active run's log.

## Sub-features

- `feed-snapshot` sends `event: snapshot` with the snapshot as one JSON `data:` line, `version: 1` (`OfficeSnapshot` in `src/officeWire.ts`).
- `feed-jobs` lists each configured scheduled job with its `nextDueAt`.
- `feed-push` sends a new snapshot when state changes (a run starts or ends, a pause is set).

## How to get to it (user POV)

- Open `/office/` in a browser. The dashboard connects to the feed through nginx. The sandbox has no nginx, so connect to the feed directly.

## Driving it with curl

Preconditions:

- A fresh sandbox, so its job file lists `verify_echo`.

- **Connect.** Run `timeout 4 curl -sN 127.0.0.1:$PORT/office/feed > feed.txt`. The file starts `retry: 3000`, then `event: snapshot` and a `data:` line.
- **Read the snapshot.** Run `grep -A1 -m1 -x 'event: snapshot' feed.txt | sed -n 's/^data: //p' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)))'`. It has `version: 1`, `activeRun: null`, and `jobs` with `{name: "verify_echo", room: "verify", at: <JOB_AT>, nextDueAt: ...}`.
- **See a push.** Keep `curl -sN` open (for example `timeout 60`) and post a freeform command in another shell. A second `event: snapshot` arrives with the run in `activeRun` or `history`. The stub finishes at once, so expect no `event: log` lines. To see them, make `$DIR/stubs/claude` sleep between lines.

## Gotchas

- `curl` without `-N` buffers the stream, and `timeout` always ends it with exit code 124. Judge by the file, not the exit code.
- The first line is `retry: 3000`, not the event. Search for `event: snapshot` rather than reading line 1.
- To look at the page itself, serve `dashboard/` and point it at the sandbox feed. Headless Chromium is at `/usr/bin/chromium`, and `~/.claude/handoffs/agent-runner-eq/dashboard8a-eq.mjs` shows a Playwright setup.
