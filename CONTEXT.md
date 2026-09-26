# agent-runner

A standalone service that runs headless coding-agent sessions one at a time, fed by the WhatsApp
bot and a cron, and reports through a Redis outbox. The office dashboard's plan is issue #17.

## Language

### Runner

**Run**:
One session under the single-flight lock, from start to its one report: freeform, Joplin, an issue run, or a scheduled job's command.
_Avoid_: task, session (for the whole run)

**Issue run**:
A run that implements one GitHub issue in an allowlisted workspace, then commits, opens a PR, reviews and merges it.

**Scheduled job**:
A configured command the runner runs once a day at a fixed UTC time (`trigger: schedule`), in place of a crontab line. It joins the **Queue** when due and runs as-is, with no preamble or post-run. Its **Room** is set in its config.
_Avoid_: cron job (the cron is the issue tracer), job (for any other run)

**Workspace**:
An allowlisted repo on the Pi, named by its alias (e.g. `chess-trainer`). Issue runs only happen in workspaces.
_Avoid_: project, repo (when you mean the alias)

**Phase**:
Where the executing run is: `agent` (an agent pass, the first one or the autofix), `post-run` (commit, PR, review, merge), or `job` (a **Scheduled job**'s command).

**Queue**:
Run requests waiting for the agent, oldest first.

**Pause**:
A hold on new runs: the safe-restart pause flag, the owner's general pause, or the owner's pause of one workspace.

### Office dashboard

**Office**:
The dashboard: a LAN page that shows the runner as an office, with the **Scene** on the left and a panel of tabs (Now, History, Office) on the right.
_Avoid_: UI, frontend, monitor

**Office feed**:
The read-only SSE endpoint (`GET /office/feed`) that sends an **Office snapshot** on connect and after every state change.
_Avoid_: websocket, API

**Live log**:
The active run's log (its autofix pass's too) as the **Office feed** streams it and the Now tab tails it: masked on the runner, the last ~200 lines on connect, cleared when a new run starts.
_Avoid_: log tail, log pane (for the concept)

**Office snapshot**:
The one JSON document the office is drawn from (`OfficeSnapshot` in `src/officeSnapshot.js`), built from the same status snapshot as `agent:status`.

**Scene**:
The office floor drawn on the page's canvas: the **Bullpen** and the rooms around it. The scene reducer (`dashboard/scene.js`) works it out from each **Office snapshot** and the scene before it, then it is drawn.
_Avoid_: map, canvas (for the concept)

**Bullpen**:
The open-plan middle of the office, where the **Cubicles** are.

**Cubicle**:
A **Workspace**'s desk in the office bullpen, one per allowlisted alias, where its issue runs are worked.

**Department sign**:
The name on a **Cubicle**. It comes from the dashboard config (`dashboard/office.json`), which also sets the cubicles' order; an alias the config doesn't name shows the alias.

**Lights off**:
The **Scene** while the runner is down (the **Office feed** can't connect): the whole office dark, with only the EXIT sign lit.

**BACK IN 5**:
The sign on the front door during the owner's general **Pause**. A paused **Workspace**'s **Cubicle** gets a "Do not disturb" sign instead.

**Boss's office**:
The corner office. Empty for now; later the boss reviews PRs from here.

**Reception**:
The office's front desk, by the front door: the **Mail carrier**, the cron countdown (a clock on the wall, hidden when the cron isn't running), and the **Queue** as letters on the **Mail cart**.

**Mail cart**:
The cart at **Reception** with one letter per queued request, oldest first; hovering a letter shows its label. When the cart is full, its last slot is a pile standing for the rest.

**Annex**:
The room for freeform runs, which work outside a known **Workspace**.

**Library**:
The room for Joplin runs, whose instructions come from a Joplin note.

**Mail carrier**:
The figure who delivers each run to its room: an interoffice envelope for a cron run, a ringing phone first for a manual (WhatsApp) one.

## Relationships

- The **Office feed** pushes **Office snapshots**; the **Office** only ever reads them.
- Each allowlisted **Workspace** has one **Cubicle**; an **Issue run** is worked in its **Cubicle**.
- A freeform **Run** is worked in the **Annex**, a Joplin **Run** in the **Library**, a **Scheduled job** in the room its config names.
- The **Queue** waits at **Reception** until the **Mail carrier** delivers the next **Run**.

## Flagged ambiguities

- "Office" names both the whole dashboard and one of its panel tabs (the tab with cron, pauses, lock and queue). In code and docs, "the Office" is the dashboard; say "the Office tab" for the tab.
