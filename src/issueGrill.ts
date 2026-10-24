/**
 * The `issue_grill` Scheduled job: grill one `agent-suggested` + `needs-triage` issue a day into a
 * spec, in a headless session running the personal `/self-grill` skill.
 */

import { errorText } from './narrow.ts';
import { REPO_INSIGHT_PRIORITY } from './repoInsight.ts';
import type { createGithubIssues } from './issuePipeline/githubIssue.ts';

// The self-grill skill opens its decision-log comment with this; the comment marks an issue as grilled.
export const GRILL_LOG_MARKER = 'Self-grill decision log';

export type GrillCandidate = { alias: string; repo: string; number: number; title: string; url: string; createdAt: string };

/**
 * The oldest candidate. Ties go to the alias earlier in `REPO_INSIGHT_PRIORITY`, then the lower
 * issue number. Null when there are none.
 */
export function pickGrillCandidate(cands: readonly GrillCandidate[]): GrillCandidate | null {
  const rank = (alias: string) => {
    const i = REPO_INSIGHT_PRIORITY.indexOf(alias);
    return i < 0 ? REPO_INSIGHT_PRIORITY.length : i;
  };
  const sorted = [...cands].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || rank(a.alias) - rank(b.alias) || a.number - b.number
  );
  return sorted[0] ?? null;
}

const isGrillLog = (body: string) => body.trimStart().startsWith(GRILL_LOG_MARKER);

/**
 * Read-only GitHub lookups for `issue_grill`, behind an injectable `github`.
 */
export function createIssueGrillLookups({ workspaces, github }: {
    workspaces: { resolveIssueWorkspace: (alias: string | null) => Promise<{ alias: string; root: string }> };
    github: Pick<ReturnType<typeof createGithubIssues>, 'resolveIssueRepo' | 'listTriageSuggestions' | 'issueCommentBodies'>;
  }) {
  return {
    /**
     * Ungrilled triage suggestions across the aliases. An alias whose workspace, repo or issue list
     * can't be read is reported in `failures` as `"<alias>: <error>"` and the rest carry on. An
     * issue reachable through two aliases is listed once, under the first.
     */
    async candidates(order: readonly string[] = REPO_INSIGHT_PRIORITY): Promise<{ candidates: GrillCandidate[]; failures: string[]; aliases: number }> {
      const candidates: GrillCandidate[] = [];
      const failures: string[] = [];
      const seen = new Set<string>();
      for (const alias of order) {
        try {
          const repo = await github.resolveIssueRepo((await workspaces.resolveIssueWorkspace(alias)).root, alias);
          for (const issue of await github.listTriageSuggestions(repo)) {
            const key = `${repo}#${issue.number}`;
            if (seen.has(key) || issue.comments.some(isGrillLog)) continue;
            seen.add(key);
            candidates.push({ alias, repo, number: issue.number, title: issue.title, url: issue.url, createdAt: issue.createdAt });
          }
        } catch (err) {
          failures.push(`${alias}: ${errorText(err)}`);
        }
      }
      return { candidates, failures, aliases: order.length };
    },

    async isGrilled(repo: string, issueNumber: number): Promise<boolean> {
      return (await github.issueCommentBodies(repo, issueNumber)).some(isGrillLog);
    },
  };
}

const lastNonEmptyLine = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

/**
 * Today's grill: pick the oldest ungrilled issue, run `/self-grill <n>` in its workspace root and
 * check the decision-log comment landed. Returns the report line, or throws when no alias could be
 * read or the session left no decision log.
 */
export async function runIssueGrill({ lookups, resolveWorkspace, launchSession }: {
    lookups: Pick<ReturnType<typeof createIssueGrillLookups>, 'candidates' | 'isGrilled'>;
    resolveWorkspace: (alias: string) => Promise<{ root: string }>;
    launchSession: (p: { cwd: string; prompt: string }) => Promise<{ text: string }>;
  }): Promise<string> {
  const { candidates, failures, aliases } = await lookups.candidates();
  const pick = pickGrillCandidate(candidates);
  if (!pick) {
    if (aliases > 0 && failures.length === aliases) throw new Error(`issue-grill: every workspace failed (${failures.join('; ')})`);
    return `issue-grill: nothing to grill${failures.length ? ` (failed: ${failures.join('; ')})` : ''}`;
  }
  const { root } = await resolveWorkspace(pick.alias);
  const { text } = await launchSession({ cwd: root, prompt: `/self-grill ${pick.number}` });
  if (!(await lookups.isGrilled(pick.repo, pick.number))) {
    throw new Error(`issue-grill: ${pick.alias} #${pick.number} finished without a decision log: ${lastNonEmptyLine(text).slice(0, 300)}`);
  }
  return `issue-grill: ${pick.alias} #${pick.number} "${pick.title}" → ${lastNonEmptyLine(text)} (${pick.url})`;
}
