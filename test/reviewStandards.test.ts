import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm, standardsBlock } from '../src/issuePipeline/llm.ts';
import type { FetchLike } from '../src/issuePipeline/llm.ts';
import { loadPipelineSettings } from '../src/issuePipeline/settings.ts';

function captureReview() {
  const userMessages: string[] = [];
  const settings = loadPipelineSettings({
    OPENAI_API_KEY: 'k',
    OPENAI_BASE_URL: 'https://example.test/v1',
    CLAUDE_REVIEW_MODEL: 'm',
    CLAUDE_REVIEW_MAX_TOKENS: '400',
    CLAUDE_REVIEW_DIFF_MAX_CHARS: '10000',
  });
  const fetchFn: FetchLike = async (_url, init) => {
    userMessages.push(JSON.parse(init.body).messages[1].content);
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'VERDICT: APPROVE' } }] }) };
  };
  return { llm: createLlm({ settings, fetchFn }), userMessages };
}

test('review includes the coding standards before the diff', async () => {
  const { llm, userMessages } = captureReview();
  await llm.review('diff --git a/x b/x', 'task', '# Coding standards\n\n- Extend, don\'t patch.');
  const [user] = userMessages;
  assert.match(user, /Repository coding standards \(CODING_STANDARDS\.md\):[\s\S]*Extend, don't patch\./);
  assert.ok(user.indexOf('Extend') < user.indexOf('diff --git'));
});

test('review without standards has no standards section', async () => {
  const { llm, userMessages } = captureReview();
  await llm.review('diff --git a/x b/x', 'task');
  assert.doesNotMatch(userMessages[0], /coding standards/i);
  assert.equal(standardsBlock('   \n'), '');
});
