#!/usr/bin/env node
/**
 * The `issue_grill` Scheduled job: grill the oldest ungrilled `agent-suggested` triage issue into a
 * spec in a headless `/self-grill` session. The last stdout line is the outcome report.
 * `npm run issue-grill`.
 */
import { loadConfig } from '../src/config.ts';
import { createWorkspaceAllowlist } from '../src/workspaces.ts';
import { createIssuePipeline } from '../src/issuePipeline/index.ts';
import { createOneShotSessionLauncher, grillSessionArgs } from '../src/agentBackend/claude.ts';
import { createIssueGrillLookups, runIssueGrill } from '../src/issueGrill.ts';
import { errorText } from '../src/narrow.ts';

async function main() {
  try {
    const config = loadConfig();
    const workspaces = createWorkspaceAllowlist();
    const github = createIssuePipeline({ settings: config.pipeline }).github;
    const line = await runIssueGrill({
      lookups: createIssueGrillLookups({ workspaces, github }),
      resolveWorkspace: (alias) => workspaces.resolveIssueWorkspace(alias),
      launchSession: createOneShotSessionLauncher({ sessionArgs: grillSessionArgs }),
    });
    console.log(line);
  } catch (err) {
    console.error(errorText(err));
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
