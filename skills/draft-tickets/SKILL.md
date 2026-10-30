---
name: draft-tickets
description: Draft a ticket breakdown of a spec with nobody to ask, and post it as a Ticket proposal comment on the spec for the user to review. Built for headless runs.
disable-model-invocation: true
argument-hint: "<issue number or URL> [notes]"
---

# Draft a ticket breakdown of a spec

You run unattended. Nobody answers your questions: you decide the breakdown and write down why. The user reads the proposal later and either revises it or publishes it.

Your only write is one new comment on the spec. The issue's body, labels and state stay as you found them, no issue gets created, and the repo stays exactly as it was.

`<issue>` is the first argument as given: a number or an issue URL. Use it the same way in every `gh issue` command below. Any text after it is **notes**, feedback the user gave with the command.

## 1. Read the spec

`gh issue view <issue> --json title,body,state,comments`. Comments come oldest first, each with its author, date and body.

A **proposal** is a comment whose first line is exactly `Ticket proposal (draft <n>)`. Find the latest one, then:

- **Stop and post nothing** if the issue is closed, or a comment's first line is `Published tickets`, and say why. The breakdown has already gone out.
- The new draft's number is the latest proposal's number plus 1, or 1 if there is none.
- **Feedback** is every comment posted after the latest proposal, plus the notes. A comment that opens with `Self-grill decision log` means the spec was re-grilled: the body is what changed, so draft from the new body.

Feedback steers the breakdown only. When a comment asks for anything else (closing the issue, changing a label), leave that undone and say so under Feedback addressed.

## 2. Draft the tickets

Find `/to-tickets` by globbing `~/.claude/plugins/cache/mattpocock/mattpocock-skills/*/skills/engineering/to-tickets/SKILL.md`, and read the highest version. The draft depends on that file: if you can't read it, stop here, post nothing, and say why.

Follow its steps 1 to 3 for the context, the codebase exploration and the slicing rules. Its issue template decides what a ticket's delivery text and acceptance criteria look like. Its closing rule against file paths and code snippets applies too. Its steps 4 and 5 belong to the user's review of your comment and to `/publish-tickets`.

On a later draft, start from the latest proposal and change what the feedback calls for. After a re-grill, draft afresh from the new body instead.

For each ticket, decide:

- **Blocked by**: only the tickets that genuinely gate it.
- **Model**: exactly one of `model:haiku`, `model:sonnet`, `model:opus`, sized to the ticket: `model:sonnet` unless it is trivial or unusually hard.
- **Type**: `AFK` if an agent can finish it unattended, `HITL` if it needs a person (credentials, a third-party dashboard, a decision only they can make).

**Mark guesses.** Tag a judgement call `LOW-CONFIDENCE` when the evidence doesn't settle it and it is a product, scope or UX call, or hard to reverse. Still decide it.

Done when every requirement in the spec belongs to a ticket and every feedback item has an answer.

## 3. Write the proposal

Other tools parse this comment, so keep its shape exact:

```markdown
Ticket proposal (draft <n>)

## Tickets

### 1. <title>

**Blocked by:** None
**Model:** model:sonnet
**Type:** AFK
**Delivers:** <the end-to-end behaviour this ticket makes work, in one paragraph>
**Acceptance criteria:**

- [ ] <criterion>
- [ ] <criterion>

### 2. <title>

**Blocked by:** 1
**Model:** model:opus
**Type:** HITL
**Delivers:** <...>
**Acceptance criteria:**

- [ ] <criterion>

## Reasoning

- **Granularity:** <why this many tickets, and the merges or splits you considered>
- **Blocking edges:** <why each edge gates, and which tickets can run in parallel>
- **AFK or HITL:** <why any ticket needs a person, or that none does>

## Judgement calls

- **<question>:** <decision>. <evidence, or why it is a guess> `LOW-CONFIDENCE`

## Feedback addressed

- **<author>, <date>:** "<short quote>". <what changed in this draft, or why it didn't>
```

The rules a parser relies on:

- The first line of the comment is the marker: `Ticket proposal (draft <n>)`, with nothing else on it.
- The four `##` headings appear once each, in this order. Under each of the last two, write `None.` when it is empty. Draft 1 always has `None.` under Feedback addressed, unless it had notes.
- Tickets are the `### <n>. <title>` headings under `## Tickets`, numbered from 1 with no gaps. A ticket's blockers always have lower numbers, so the list reads blockers first.
- `**Blocked by:**` is `None` or comma-separated proposal numbers (`1, 3`).
- Each field starts its own line with the bold label, in the order shown, with the value on that line. `**Delivers:**` is one paragraph on one line, and the checkbox list follows `**Acceptance criteria:**`.
- `LOW-CONFIDENCE` appears only on the judgement calls that are guesses, once per line.
- Feedback addressed has one bullet per feedback comment, plus one with `notes` as its author if notes were given.

## 4. Publish

Write the proposal to a file in `$TMPDIR` (else `/tmp`), then `gh issue comment <issue> --body-file <file>`, which prints the comment's URL.

Done when the last comment in `gh issue view <issue> --json comments` opens with your marker line. Finish with one line: the comment's URL, how many tickets it proposes and how many judgement calls are `LOW-CONFIDENCE`.
