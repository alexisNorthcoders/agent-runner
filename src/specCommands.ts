/**
 * The `claude spec:<action>:…` commands, which act on a self-grilled spec (an `agent-suggested` +
 * `needs-triage` issue with a decision log) without running an agent.
 */

import { grillLogCount, latestGrillLog } from './issueGrill.ts';
import { AGENT_SUGGESTED_LABEL, NEEDS_TRIAGE_LABEL } from './issuePipeline/githubIssue.ts';
import type { createGithubIssues, IssueDetail } from './issuePipeline/githubIssue.ts';
import { errorText } from './narrow.ts';
import type { Command, SpecRunAction } from './commands.ts';

/**
 * `not-a-spec`: no decision log. `to-review`: grilled, waiting for the owner. `breakdown-to-approve`: a
 * Ticket proposal came after the latest decision log.
 */
export type SpecState = 'not-a-spec' | 'to-review' | 'breakdown-to-approve';

const PROPOSAL_MARKER = /^Ticket proposal \(draft \d+\)\s*(\n|$)/;
const isProposal = (body: string) => PROPOSAL_MARKER.test(body.trimStart());
const proposalCount = (comments: readonly string[]) => comments.filter(isProposal).length;

/** An issue's spec state, from its comment bodies oldest first. A re-grill after a proposal is a spec to review again. */
export function specState(comments: readonly string[]): SpecState {
  const lastLog = comments.findLastIndex((c) => latestGrillLog([c]));
  if (lastLog < 0) return 'not-a-spec';
  return comments.findLastIndex(isProposal) > lastLog ? 'breakdown-to-approve' : 'to-review';
}

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
  /** Ticket proposals the issue had before the run. */
  proposalsBefore: number;
};

const PAST: Record<SpecRunAction, string> = { regrill: 'regrilled', approve: 'approved', revise: 'revised' };

type Before = Pick<SpecRun, 'logsBefore' | 'proposalsBefore'>;

/** The link to show for a comment the run left: the comment's own when GitHub gave it, else the issue's. */
const linkTo = (issue: Pick<IssueDetail, 'url' | 'commentUrls'>, index: number) => issue.commentUrls?.[index] || issue.url;

/**
 * What each run action asks the session for, and the comment that proves it did it (`landed` returns
 * that comment's link). `needs` is the one spec state the action fits, with the command that fits the other.
 */
const RUN_ACTIONS: Record<SpecRunAction, {
  prompt: (url: string, notes: string) => string;
  landed: (before: Before, issue: Pick<IssueDetail, 'url' | 'comments' | 'commentUrls'>) => string | null;
  expected: string;
  needs?: { state: SpecState; otherwise: Partial<Record<SpecState, string>> };
}> = {
  regrill: {
    prompt: (url, notes) =>
      `/self-grill ${url}\n\nThis spec was already grilled: take its latest decision log and the comments posted after it into account, and post a new decision log.${notes ? `\n\nThe owner's notes:\n${notes}` : ''}`,
    landed: (before, issue) => (grillLogCount(issue.comments) > before.logsBefore ? linkTo(issue, issue.comments.findLastIndex((c) => latestGrillLog([c]))) : null),
    expected: 'a new decision log',
  },
  approve: {
    prompt: (url) => `/draft-tickets ${url}`,
    landed: (before, issue) => (proposalCount(issue.comments) > before.proposalsBefore ? linkTo(issue, issue.comments.findLastIndex(isProposal)) : null),
    expected: 'a new Ticket proposal comment',
    needs: { state: 'to-review', otherwise: { 'breakdown-to-approve': 'it already has a Ticket proposal, so revise it with claude spec:revise' } },
  },
  revise: {
    prompt: (url, notes) => `/draft-tickets ${url}${notes ? ` ${notes}` : ''}`,
    landed: (before, issue) => (proposalCount(issue.comments) > before.proposalsBefore ? linkTo(issue, issue.comments.findLastIndex(isProposal)) : null),
    expected: 'a new Ticket proposal comment',
    needs: { state: 'breakdown-to-approve', otherwise: { 'to-review': 'it has no Ticket proposal yet, so approve it with claude spec:approve' } },
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
        if (refusal) return `Not ${PAST[cmd.action]}: ${repo}#${cmd.issueNumber} (${issue.url}) is not a spec to review: ${refusal}. Nothing changed.`;
        const needs = RUN_ACTIONS[cmd.action].needs;
        const state = specState(issue.comments);
        if (needs && state !== needs.state) {
          const fits = needs.otherwise[state];
          return `Not ${PAST[cmd.action]}: ${repo}#${cmd.issueNumber} (${issue.url}) is a ${state === 'to-review' ? 'spec to review' : 'breakdown to approve'}: ${fits}:${ws.alias}:${cmd.issueNumber}. Nothing changed.`;
        }
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
          proposalsBefore: proposalCount(issue.comments),
        };
      } catch (err) {
        return `Could not ${cmd.action} #${cmd.issueNumber}: ${errorText(err)}`;
      }
    },

    /** The link to the comment a finished run was meant to leave, or null when it isn't there. */
    async landed(run: SpecRun): Promise<string | null> {
      return RUN_ACTIONS[run.action].landed(run, await github.issueDetail(run.repo, run.issueNumber));
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
