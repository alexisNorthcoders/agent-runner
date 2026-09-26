/**
 * Prepended to every agent prompt. The agent runs as a child of agent-runner, so restarting that
 * PM2 app kills the run before it can report.
 * @param {{ repoRoot: string }} p
 */
export function buildPreamble({ repoRoot }) {
  return `[Invocation from agent-runner (headless, requested over WhatsApp). Read carefully.]
- Never restart, reload, stop or delete the \`agent-runner\` PM2 process (\`pm2 restart agent-runner\`, \`pm2 reload\`, \`pm2 delete\`, \`killall node\`, …). This run is its child: that kills the run and its report.
- If agent-runner itself must be restarted, run \`npm run safe-restart\` in ${repoRoot}. It refuses while any run is active, including this one. If your own run is the blocker, don't work around it: say in your summary that a restart is needed, and the user will send \`claude:restart\` afterwards.
- Restarting other PM2 apps, including \`whatsapp\` (the bot), is allowed.
- Your final message is sent back to the user on WhatsApp, so end with a short summary.`;
}

/**
 * The preamble for freeform and Joplin runs. Unlike an issue run, nothing commits after the agent,
 * and a repo left dirty blocks later issue runs there (the cron's git prep refuses a dirty tree).
 * @param {{ repoRoot: string }} p
 */
export function buildFreeformPreamble({ repoRoot }) {
  return `${buildPreamble({ repoRoot })}
- Git: a request may be only system work (PM2, config outside a repo, answering a question). Then there's nothing to commit. But whenever you change files in a git repo, never leave that repo dirty or off its default branch. Unless the request says otherwise, finish each repo you changed like this:
  1. Before editing, run \`git status\`. If the repo already has uncommitted changes you didn't make, or is on another branch with unpushed work, don't touch, commit or discard them. Leave that repo alone and say so in your summary.
  2. Start from the up-to-date default branch (\`git pull --ff-only\`) and make a new branch \`claude/<short-slug>\`.
  3. Run the repo's checks (tests, typecheck, lint, as its CLAUDE.md or README says) and fix any failures.
  4. Commit only your changes, push, and open a PR with \`gh pr create\`.
  5. Review the PR diff (\`gh pr diff\`) with fresh eyes, for bugs and against the repo's CLAUDE.md conventions. Fix what you find, re-run the checks and push.
  6. Merge with \`gh pr merge --squash --delete-branch\`. If checks fail or the merge is blocked, don't force it: leave the PR open and say why.
  7. Check out the default branch, \`git pull --ff-only\`, and confirm \`git status\` is clean.
  In your summary, list each repo you changed with its PR link and whether it merged.`;
}
