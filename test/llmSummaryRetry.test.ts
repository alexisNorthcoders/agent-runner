import test from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../src/issuePipeline/llm.ts";
import { loadPipelineSettings } from "../src/issuePipeline/settings.ts";

const settings = loadPipelineSettings({
  DEEPINFRA_API_KEY: "k",
  DEEPINFRA_BASE_URL: "http://x",
  CLAUDE_POST_CLOSE_CHANGES_MODEL: "m",
  CLAUDE_POST_CLOSE_CHANGES_MAX_TOKENS: "100",
});
const ok = {
  ok: true,
  status: 200,
  text: async () =>
    JSON.stringify({ choices: [{ message: { content: "done" } }] }),
};
const busy = { ok: false, status: 429, text: async () => "engine_overloaded" };

test("issueClosedSummary retries a 429 and succeeds", async () => {
  const seq = [busy, busy, ok];
  const llm = createLlm({
    settings,
    fetchFn: async () => seq.shift() ?? ok,
    retryDelaysMs: [1, 1, 1],
  });
  const r = await llm.issueClosedSummary("issue");
  assert.equal(r.ok, true);
  assert.equal(r.text, "done");
});

test("issueClosedSummary gives up after the retries", async () => {
  let calls = 0;
  const llm = createLlm({
    settings,
    fetchFn: async () => (calls++, busy),
    retryDelaysMs: [1, 1],
  });
  const r = await llm.issueClosedSummary("issue");
  assert.equal(r.ok, false);
  assert.equal(calls, 3);
});

test("issueClosedSummary reports a body that is not a JSON object as an error", async () => {
  const llm = createLlm({ settings, fetchFn: async () => ({ ok: true, status: 200, text: async () => "null" }) });
  const r = await llm.issueClosedSummary("issue");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not a JSON object/);
});
