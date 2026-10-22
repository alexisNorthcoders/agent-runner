import test from "node:test";
import assert from "node:assert/strict";
import { createLlm } from "../src/issuePipeline/llm.ts";

const settings = /** @type {any} */ ({
  summary: { apiKey: "k", baseUrl: "http://x", model: "m", maxTokens: 100 },
  review: {},
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
    fetchFn: async () => seq.shift(),
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
