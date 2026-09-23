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
