/**
 * The `claude spec:<action>:…` commands, which act on a self-grilled spec (an `agent-suggested` +
 * `needs-triage` issue with a decision log) without running an agent.
 */

import { latestGrillLog } from './issueGrill.ts';
import { AGENT_SUGGESTED_LABEL, NEEDS_TRIAGE_LABEL } from './issuePipeline/githubIssue.ts';
import type { createGithubIssues, IssueDetail } from './issuePipeline/githubIssue.ts';
import { errorText } from './narrow.ts';
import type { Command } from './commands.ts';

/** `not-a-spec`: no decision log. `to-review`: grilled, waiting for the owner. */
export type SpecState = 'not-a-spec' | 'to-review';

/** An issue's spec state, from its comment bodies oldest first. */
export const specState = (comments: readonly string[]): SpecState => (latestGrillLog(comments) ? 'to-review' : 'not-a-spec');

/** Why a spec command can't act on this issue, or null when it can. */
export function specRefusal(issue: Pick<IssueDetail, 'state' | 'labels' | 'comments'>): string | null {
  if (issue.state !== 'open') return 'it is closed';
  const missing = [AGENT_SUGGESTED_LABEL, NEEDS_TRIAGE_LABEL].filter((l) => !issue.labels.includes(l));
  if (missing.length) return `it is not labelled ${missing.join(' + ')}`;
  if (specState(issue.comments) === 'not-a-spec') return 'it has no self-grill decision log';
  return null;
}

export function createSpecCommands({ workspaces, github }: {
    workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'issueDetail' | 'rejectIssue'>;
  }) {
  return {
    /** Label a spec to review `wontfix` and close it as not planned. Returns the WhatsApp reply. */
    async reject(cmd: Extract<Command, { kind: 'spec' }>): Promise<string> {
      try {
        const ws = await workspaces.resolveIssueWorkspace(cmd.alias);
        const repo = await github.resolveIssueRepo(ws.root, ws.alias);
        const issue = await github.issueDetail(repo, cmd.issueNumber);
        const refusal = specRefusal(issue);
        if (refusal) return `Not rejected: ${repo}#${cmd.issueNumber} (${issue.url}) is not a spec to review: ${refusal}. Nothing changed.`;
        await github.rejectIssue(repo, cmd.issueNumber);
        return `Rejected ${repo}#${cmd.issueNumber} "${issue.title}": labelled wontfix and closed as not planned.\n${issue.url}`;
      } catch (err) {
        return `Could not reject #${cmd.issueNumber}: ${errorText(err)}`;
      }
    },
  };
}

export type SpecCommands = ReturnType<typeof createSpecCommands>;
