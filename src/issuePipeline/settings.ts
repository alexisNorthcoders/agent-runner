/**
 * Issue-pipeline settings from the environment. The names are the bot's (`CLAUDE_POST_RUN*`,
 * `CLAUDE_REVIEW_*`, …) so its `.env` lines carry over unchanged. Every step defaults to on; set
 * its flag to `0` to turn it off. Pure: tests build settings from a plain object.
 *
 * @typedef {ReturnType<typeof loadPipelineSettings>} PipelineSettings
 */

/** @param {string | undefined} v @param {number} fallback @param {number} [min] */
const num = (v, fallback, min = 1) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/** @param {Record<string, string | undefined>} [env] */
export function loadPipelineSettings(env = process.env) {
  const on = (name) => env[name] !== '0';
  const str = (name, fallback = '') => env[name]?.trim() || fallback;
  const useMaxCompletionTokens = env.CLAUDE_REVIEW_USE_MAX_COMPLETION_TOKENS;
  return {
    /** `CLAUDE_POST_RUN=0` skips everything after the agent (commit, PR, review, merge). */
    postRun: on('CLAUDE_POST_RUN'),
    log: on('CLAUDE_POST_RUN_LOG'),
    push: on('CLAUDE_POST_RUN_PUSH'),
    pr: on('CLAUDE_POST_RUN_PR'),
    /** One agent pass after `VERDICT: REQUEST_CHANGES`. */
    autofix: on('CLAUDE_POST_RUN_AUTOFIX'),
    /** `gh pr merge --auto` (or a direct merge) once the review gate passes. */
    autoMerge: on('CLAUDE_POST_RUN_PR_AUTO_MERGE'),
    /** On a stale PR head, merge the base in through the update-branch API and retry. */
    staleHeadSync: on('CLAUDE_POST_RUN_PR_STALE_HEAD_SYNC'),
    /** Ceiling for every `gh`/`git` call, so a hung call can't hold the run lock forever. */
    execTimeoutMs: num(env.CLAUDE_POST_RUN_EXEC_TIMEOUT_MS, 90_000),
    /** Polling for the agent's writes to show up in git after it exits. */
    gitWait: { pollMs: num(env.CLAUDE_POST_RUN_POLL_MS, 250, 0), maxWaitMs: num(env.CLAUDE_POST_RUN_MAX_WAIT_MS, 8000) },
    /** Polling for GitHub to report the PR mergeable before a direct merge. */
    mergeableWait: {
      pollMs: num(env.CLAUDE_POST_RUN_MERGEABLE_POLL_MS, 2000, 0),
      maxWaitMs: num(env.CLAUDE_POST_RUN_MERGEABLE_MAX_WAIT_MS, 90_000),
    },
    /** Polling for the linked issue to close after the merge (30 min: slow CI used to miss it). */
    issueCloseWait: {
      pollMs: num(env.CLAUDE_POST_RUN_ISSUE_CLOSE_POLL_MS, 4000, 0),
      maxWaitMs: num(env.CLAUDE_POST_RUN_ISSUE_CLOSE_MAX_WAIT_MS, 1_800_000),
    },
    issueBranchPrefix: str('CLAUDE_ISSUE_BRANCH_PREFIX', 'claude/issue'),
    /** Branch for a commit that would otherwise land on the default branch. */
    workBranchPrefix: str('CLAUDE_CLI_BRANCH_PREFIX', 'claude/wa'),
    ghBin: str('GH_BIN'),
    /** `alias=owner/repo,…`: which GitHub repo an alias's issues live in, when origin doesn't say. */
    issueRepoMap: str('CLAUDE_ISSUE_REPO_MAP'),
    review: {
      apiKey: str('OPENAI_API_KEY'),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      model: str('CLAUDE_REVIEW_MODEL', 'gpt-5.4-mini'),
      fallbackModel: str('CLAUDE_REVIEW_FALLBACK_MODEL', 'gpt-5.4-nano'),
      diffMaxChars: num(env.CLAUDE_REVIEW_DIFF_MAX_CHARS, 100_000),
      maxTokens: num(env.CLAUDE_REVIEW_MAX_TOKENS, 2500),
      /** `1`/`0` forces `max_completion_tokens` on/off; unset → on for gpt-5 / o-series. */
      useMaxCompletionTokens: useMaxCompletionTokens === '1' ? true : useMaxCompletionTokens === '0' ? false : null,
      autofixReviewMaxChars: num(env.CLAUDE_POST_RUN_AUTOFIX_REVIEW_MAX_CHARS, 12_000),
    },
    /** The "changes made" email after the issue closes (DeepInfra, OpenAI-compatible). */
    summary: {
      apiKey: str('DEEPINFRA_API_KEY'),
      baseUrl: str('DEEPINFRA_BASE_URL', 'https://api.deepinfra.com/v1/openai'),
      model: str('CLAUDE_POST_CLOSE_CHANGES_MODEL', 'meta-llama/Meta-Llama-3-8B-Instruct'),
      issueBodyMaxChars: num(env.CLAUDE_POST_CLOSE_ISSUE_BODY_MAX_CHARS, 12_000),
      maxTokens: num(env.CLAUDE_POST_CLOSE_CHANGES_MAX_TOKENS, 1024),
    },
    email: {
      user: str('GMAIL_EMAIL'),
      pass: str('GMAIL_PASSWORD'),
      to: str('CLAUDE_REVIEW_EMAIL_TO') || str('GMAIL_EMAIL'),
      subjectPrefix: str('CLAUDE_REVIEW_EMAIL_SUBJECT_PREFIX'),
    },
  };
}
