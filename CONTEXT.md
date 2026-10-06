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

**Inferred workspace**:
The **Workspace** a freeform **Run** turned out to work in: the first one its agent edits a file in or runs a command in (reads don't count). Set once, it never changes for the run.
_Avoid_: target repo, detected workspace

**Phase**:
Where the executing run is: `agent` (an agent pass, the first one or the autofix), `post-run` (commit, PR, review, merge), or `job` (a **Scheduled job**'s command).

**Model choice**:
The model a **Run**'s agent passes use, and where it came from: the run's model prefix (`claude opus: …`, freeform and Joplin runs), its issue's `model:` label, the **Workspace**'s own agent settings, or the runner default (Sonnet), in that order. An issue run's autofix pass keeps it.
_Avoid_: classifier, orchestrator (nothing decides automatically), model override

**Queue**:
Run requests waiting for the agent, oldest first, except a manual request the usage limit stopped before it started (0–1 turns), which goes back to the front.

**Pause**:
A hold on new runs: the safe-restart pause flag, the owner's general pause, the owner's pause of one workspace, or the usage-limit pause (set when the agent hits its usage limit, until it resets; `claude:resume` with no alias ends it early, with the owner's pauses).

### Office dashboard

**Office**:
The dashboard: a LAN page that shows the runner as an office, with the **Scene** on the left and a panel of tabs (Now, Issues, History, Office) on the right.
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
The open-plan middle of the office, where the **Cubicles** are, in rows with an **Aisle** in front of each.

**Corridor**:
The hallway between the column of side rooms and the **Bullpen** (in the stacked layout, the lane down its edge). It opens straight into the Bullpen's **Aisles**; the side rooms open onto it through their **Doors**. Everyone who walks the office (the **Mail carrier**, the boss, a **Worker** moving desks, a **Resident** on a **Break**, the **Night janitor**) goes by Corridor and Aisle, never through a wall.
_Avoid_: hallway, path

**Aisle**:
The walkway in front of a row of **Cubicles**, inside the **Bullpen**, joining the **Corridors**. A cubicle is entered from its Aisle, through its open front.

**Door**:
A side room's door onto its **Corridor**, which swings open as someone walks through and closes behind them. Not the **front door**.

**Front door**:
The door in the **Queue room**'s back wall, out of the office. Nobody walks through it; it carries the **BACK IN 5** sign and the EXIT sign.

**Cubicle**:
A **Workspace**'s desk in the office bullpen, one per allowlisted alias, where its issue runs are worked, and freeform runs whose **Inferred workspace** it is. A **Scheduled job**'s room label that isn't a workspace's alias or **Department sign** gets a cubicle of its own; each job has its own desk in its room's cubicle. A job that's a plain script (a clerk's, not a janitor's or an analyst's) sits instead in its room's scripts room, a cubicle of its own signed `<room> scripts`.

**Department sign**:
The name on a **Cubicle**: its **Workspace**'s alias, unless the dashboard config (`dashboard/office.json`), which also sets the cubicles' order, gives it another name.

**Lights off**:
The **Scene** while the runner is down (the **Office feed** can't connect): the whole office dark, with only the EXIT sign lit.

**BACK IN 5**:
The sign on the front door during the owner's general **Pause**. A paused **Workspace**'s **Cubicle** gets a "Do not disturb" sign instead.

**Review room**:
The corner office, signed REVIEW, where the boss sits. During an issue run's post-run the boss walks to the **Worker**'s desk and reads over their shoulder (the review), and stays through the autofix.
_Avoid_: boss's office

**Worker**:
The figure at a desk working the active **Run**: typing in the `agent` phase, still while the boss reads during post-run, scribbling during the autofix. Beside them are their **Paper pile** and a speech bubble with the run's last activity (a **Scheduled job**'s latest output line). Each **Scheduled job** has its own worker at its desk: a janitor (cleanup), an analyst (insight, report) or a clerk. Everyone has a look of their own (skin, hair, shirt, tie, glasses or a beard), the same on every page: no two in the office share both shirt and hair colour. A **Workspace**'s **Resident** and the Worker on its runs are the same person, and so look the same.

**Resident**:
A **Workspace**'s own figure at its **Cubicle**'s desk while no **Run** is worked there: in through the morning, day and evening on the viewer's clock, home at night. They idle (sitting still, sipping coffee, stretching, dozing off, far more in a quiet cubicle with no run for three days) and react to what's really going on: flicking through their in-tray, peering at the cubicle next door where a run is being worked, cheering a merge in their cubicle or clapping one next door. Now and then one takes a **Break**. A resident never types, piles up papers or speaks in a bubble: that's the **Worker**'s, so a real run stands out. When the run's Worker arrives at their desk, the Worker is them, at work.
_Avoid_: idle worker, NPC

**Break**:
A **Resident** leaving their desk for a while: to the water cooler in the Freeform room, the Joplin room's bookshelf, or a neighbour's **Cubicle** for a chat, by **Corridor** and **Aisle**, and back. A couple at most at once, never someone on Do Not Disturb, and the same on every page.

**Helper**:
A colleague standing in for one of the active **Run**'s subagents: the **Resident** of the nearest **Cubicle** (or a temp from the Queue room when none can come), who walks over to the **Worker**'s desk, stands there with a tag naming the tool their subagent is using, and walks back when it's done.
_Avoid_: subagent (for the figure), assistant

**Night janitor**:
Who mops up and down the **Aisles** at night, when the **Residents** are home and the lights are down everywhere but where someone's in (the Queue and Review rooms, the active run's room, and rooms with a **Scheduled job**'s worker at their desk). Not a cleanup job's worker.

**Paper pile**:
The sheets on the **Worker**'s desk: one per few turns and per few minutes, to a cap, and never shrinking during a run.

**Outcome**:
How a room's last **Run** went, shown in that room until its next run starts: stamped (merged), a folder on the boss's desk (PR open), injured (failed), asleep (timed out), gone home, their room dark (stopped; not **Lights off**, which is the whole office), dizzy (interrupted by a restart), or a shrug and a tumbleweed (no changes). It comes from the room's latest history row.
_Avoid_: result (that's an issue run's pipeline result, one input to it), status

**Cubicle filter**:
The workspace the panel's Issues and History tabs are narrowed to, picked by clicking its **Cubicle**; clicking it again, or elsewhere on the floor, clears it.

**Issue scan**:
The runner's periodic read of every **Workspace** repo's open issues with `gh` (on startup, every ~5 minutes, after each **Run**), cached for the **Office feed**. A repo whose scan failed keeps its last good data, marked stale.
_Avoid_: issue poll, sync

**Pending issues**:
A repo's `ready-for-agent` issues, split into runnable, blocked (an open native dependency) and parked (an open agent PR the cron has already attempted in its current state), plus its `ready-for-human` issues and triage counts. Blocked and parked follow the cron issue tracer's rules.

**In-tray**:
The tray in front of a **Cubicle**'s desk with a letter per runnable issue, and a letter with a padlock per blocked one.

**Sticky note**:
The note on a **Cubicle**'s monitor while its repo has `ready-for-human` issues.

**Parked folder**:
A folder with a red clip on the boss's desk for each PR the cron has parked, beside the folders of rooms whose last run left a PR open.

**Queue room**:
The office's front desk, by the front door, signed QUEUE: the **Mail carrier**, the cron countdown (a clock on the wall, hidden when the cron isn't running), and the **Queue** as letters on the **Mail cart**.
_Avoid_: reception

**Mail cart**:
The cart in the **Queue room** with one letter per queued request, oldest first; hovering a letter shows its label. When the cart is full, its last slot is a pile standing for the rest.

**Freeform room**:
The room signed FREEFORM, for freeform runs, which work outside a known **Workspace**. A freeform run's **Worker** starts here and walks to a **Cubicle** once the run's **Inferred workspace** is set.
_Avoid_: annex

**Joplin room**:
The room signed JOPLIN, for Joplin runs, whose instructions come from a Joplin note.
_Avoid_: library

**Mail carrier**:
The figure who delivers each run to its room: an interoffice envelope for a cron run, a ringing phone first for a manual (WhatsApp) one. They also hand out the mail: a new issue's letter (one the page hasn't seen in that **Cubicle**'s in-tray before) stays in their bag until they walk a round of the cubicles with new letters and drop it in the in-tray. Runs and rounds of mail queue for them in the order they came in, so a run that comes in mid-round waits until they're back.

## Relationships

- The **Office feed** pushes **Office snapshots**; the **Office** only ever reads them.
- Each allowlisted **Workspace** has one **Cubicle**; an **Issue run** is worked in its **Cubicle**.
- A freeform **Run** is worked in the **Freeform room**, or in the **Cubicle** of its **Inferred workspace** once it has one; a Joplin **Run** in the **Joplin room**, a **Scheduled job** in the room its config names.
- The **Queue** waits in the **Queue room** until the **Mail carrier** delivers the next **Run**.
- Every walk goes out through a room's **Door**, along the **Corridors** and **Aisles**, and in through the next room's **Door** or a **Cubicle**'s open front.

## Flagged ambiguities

- "Office" names both the whole dashboard and one of its panel tabs (the tab with cron, pauses, lock and queue). In code and docs, "the Office" is the dashboard; say "the Office tab" for the tab.
