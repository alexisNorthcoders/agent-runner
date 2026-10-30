/**
 * The `claude spec:<action>:…` commands, which act on a self-grilled spec (an `agent-suggested` +
 * `needs-triage` issue with a decision log) without running an agent.
 */

import { grillLogCount, latestGrillLog } from './issueGrill.ts';
import { AGENT_SUGGESTED_LABEL, NEEDS_TRIAGE_LABEL } from './issuePipeline/githubIssue.ts';
import type { createGithubIssues, IssueDetail } from './issuePipeline/githubIssue.ts';
import { errorText } from './narrow.ts';
import type { Command, SpecRunAction } from './commands.ts';

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

/** A spec run ready to start: where, what to tell the session, and the state its result is checked against. */
export type SpecRun = {
  action: SpecRunAction;
  alias: string;
  root: string;
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  prompt: string;
  /** Decision logs the issue had before the run. */
  logsBefore: number;
};

/** What each run action asks the session for, and the comment that proves it did it. */
const RUN_ACTIONS: Record<SpecRunAction, { prompt: (url: string, notes: string) => string; landed: (before: number, comments: readonly string[]) => boolean; expected: string }> = {
  regrill: {
    prompt: (url, notes) =>
      `/self-grill ${url}\n\nThis spec was already grilled: take its latest decision log and the comments posted after it into account, and post a new decision log.${notes ? `\n\nThe owner's notes:\n${notes}` : ''}`,
    landed: (before, comments) => grillLogCount(comments) > before,
    expected: 'a new decision log',
  },
};

export const specRunExpectation = (action: SpecRunAction) => RUN_ACTIONS[action].expected;

export function createSpecCommands({ workspaces, github }: {
    workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'issueDetail' | 'rejectIssue'>;
  }) {
  return {
    /**
     * Check the spec precondition (as `reject` does) and build the run. A string is the reply that
     * says why nothing runs.
     */
    async prepare(cmd: Extract<Command, { kind: 'spec' }> & { action: SpecRunAction }): Promise<SpecRun | string> {
      try {
        const ws = await workspaces.resolveIssueWorkspace(cmd.alias);
        const repo = await github.resolveIssueRepo(ws.root, ws.alias);
        const issue = await github.issueDetail(repo, cmd.issueNumber);
        const refusal = specRefusal(issue);
        if (refusal) return `Not ${cmd.action}ed: ${repo}#${cmd.issueNumber} (${issue.url}) is not a spec to review: ${refusal}. Nothing changed.`;
        return {
          action: cmd.action,
          alias: ws.alias,
          root: ws.root,
          repo,
          issueNumber: cmd.issueNumber,
          title: issue.title,
          url: issue.url,
          prompt: RUN_ACTIONS[cmd.action].prompt(issue.url, cmd.notes),
          logsBefore: grillLogCount(issue.comments),
        };
      } catch (err) {
        return `Could not ${cmd.action} #${cmd.issueNumber}: ${errorText(err)}`;
      }
    },

    /** Whether the comment a finished run was meant to leave is there. */
    async landed(run: SpecRun): Promise<boolean> {
      return RUN_ACTIONS[run.action].landed(run.logsBefore, (await github.issueDetail(run.repo, run.issueNumber)).comments);
    },

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
