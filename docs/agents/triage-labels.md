# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

Note: the runner's cron issue tracer polls this repo (`agent-runner` is in
`CRON_SECONDARY_WORKSPACE_ALIASES`), so `ready-for-agent` means an unattended run will pick the
issue up on a coming tick, as in the other workspaces. A manual `claude issue:agent-runner:<n>`
starts one sooner.

## `ready-for-agent` is for tickets, not specs

Only tickets (one agent-sized unit of work, e.g. from `/to-tickets`) get `ready-for-agent`. A spec
is input for `/to-tickets`, not work for an AFK agent: publish it without `ready-for-agent`. Write
specs with the user-level `/to-spec`, not `/mattpocock-skills:to-spec`, which applies the label.
The cron issue tracer picks up every `ready-for-agent` issue, so a labelled spec would run as one
oversized issue.

## Every `ready-for-agent` ticket gets a model label

When you apply `ready-for-agent`, also apply exactly one of `model:haiku`, `model:sonnet` or
`model:opus`, sized to the ticket (`model:sonnet` unless it is trivial or unusually hard).
agent-runner runs the issue on that model. Without a label, it uses the workspace's `.claude`
settings model if one is set, else agent-runner's default, so the choice is left to chance.
