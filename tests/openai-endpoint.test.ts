import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAiArticleEvaluator } from "../src/infrastructure/llm/openai-article-evaluator.js";
import { createDefaultProfile } from "../src/domain/channel-profile.js";
import type { LlmEvaluator } from "../src/domain/ports.js";

const input: Parameters<LlmEvaluator["assess"]>[0] = {
  article: {
    id: "a",
    source: "test",
    sourceLabel: "Test",
    sourceQuality: 1,
    externalId: "a",
    url: "https://example.com/a",
    title: "Architecture",
    summary: "Summary",
    content: "Untrusted article body",
    contentStatus: "extracted",
    author: null,
    tags: ["architecture"],
    imageUrl: null,
    popularity: 1,
    publishedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
  },
  profile: createDefaultProfile("test", "Test"),
  rankingAlgorithm: "test",
  base: { score: 0.5, features: {}, contributions: {} },
};

test("evaluator uses standard Chat Completions with configurable endpoint and validates output", async (context) => {
  let calls = 0;
  let responseContent = JSON.stringify({
    relevance: 0.9,
    novelty: 0.8,
    quality: 0.7,
    topics: ["Architecture"],
    reason: "Relevant technical detail",
  });
  let status = 200;
  const server = createServer(async (request, response) => {
    calls++;
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer test-token");
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    assert.equal(parsed.model, "self-hosted-model");
    assert.equal(parsed.messages[0].role, "system");
    assert.match(parsed.messages[1].content, /Untrusted article body/);
    assert.deepEqual(parsed.response_format, { type: "json_object" });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        status === 200
          ? {
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1,
              model: parsed.model,
              choices: [
                {
                  index: 0,
                  finish_reason: "stop",
                  message: { role: "assistant", content: responseContent },
                },
              ],
            }
          : { error: { message: "overloaded" } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const evaluator = new OpenAiArticleEvaluator(
    "test-token",
    "self-hosted-model",
    { baseURL: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 1000 },
  );
  const result = await evaluator.assess(input);
  assert.ok(Math.abs(result!.score - 0.82) < 1e-12);
  assert.equal(result?.model, evaluator.name);
  assert.deepEqual(result?.topics, ["architecture"]);
  responseContent = '{"relevance":8}';
  await assert.rejects(() => evaluator.assess(input));
  status = 503;
  await assert.rejects(() => evaluator.assess(input));
  assert.equal(
    calls,
    3,
    "SDK must not amplify attempts through automatic retries",
  );
});

test("evaluator aborts a stalled compatible endpoint", async (context) => {
  const server = createServer(() => { /* Simulate an inference request that never finishes. */ });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const evaluator = new OpenAiArticleEvaluator("test", "model", { baseURL: `http://127.0.0.1:${address.port}/v1`, timeoutMs: 50 });
  await assert.rejects(() => evaluator.assess(input), /timed out/);
});
