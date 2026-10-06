import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLlm, standardsBlock } from '../src/issuePipeline/llm.js';

function captureReview() {
  /** @type {string[]} */
  const userMessages = [];
  const settings = /** @type {any} */ ({
    review: { apiKey: 'k', baseUrl: 'https://example.test/v1', model: 'm', maxTokens: 400, diffMaxChars: 10_000 },
    summary: {},
  });
  const fetchFn = async (_url, init) => {
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
