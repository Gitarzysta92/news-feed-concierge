import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RankFeed } from "../src/application/rank-feed.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import type { IncomingArticle, ProcessingStage } from "../src/domain/model.js";
import type { LlmEvaluator } from "../src/domain/ports.js";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("ranked articles expose completed, skipped, cached, and failed processing outcomes", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-processing-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();
  await repository.upsertArticle(article("selected", "extracted", 100));
  await repository.upsertArticle(article("outside-budget", "extracted", 1));
  await repository.upsertArticle(article("no-full-text", "failed", 1_000));

  let calls = 0;
  const evaluator: LlmEvaluator = {
    enabled: true,
    name: "test-semantic-v1",
    async assess() {
      calls += 1;
      return {
        relevance: 0.9,
        novelty: 0.8,
        quality: 0.7,
        score: 0.82,
        topics: ["test"],
        reason: "Semantic test result",
        model: "test-semantic-v1",
      };
    },
  };
  const rankFeed = new RankFeed(repository, new ClassicRankingAlgorithm(), evaluator, 0.3, 10, 1);
  const first = await rankFeed.execute("processing", "Processing", { limit: 10 });
  assert.equal(calls, 1);
  assert.ok(first.every((item) => item.algorithm.id === "interpretable-linear-v1"));
  assert.ok(first.every((item) => item.algorithm.displayName === "Interpretable Linear Ranker"));
  assert.equal(stage(first, "selected", "semantic-evaluation").status, "completed");
  assert.match(stage(first, "outside-budget", "semantic-evaluation").detail, /top 1 full-text candidates/);
  assert.equal(stage(first, "outside-budget", "semantic-evaluation").status, "skipped");
  assert.match(stage(first, "no-full-text", "semantic-evaluation").detail, /Requires successfully extracted full text/);
  assert.equal(stage(first, "no-full-text", "full-text").status, "failed");

  const cached = await rankFeed.execute("processing", "Processing", { limit: 10 });
  assert.equal(calls, 1);
  assert.equal(stage(cached, "selected", "semantic-evaluation").status, "completed");

  const cacheOnly = await rankFeed.execute("processing-fast", "Processing fast", {
    limit: 10,
    semanticMode: "cached-only",
  });
  assert.equal(calls, 1);
  assert.equal(stage(cacheOnly, "selected", "semantic-evaluation").status, "skipped");
  assert.match(stage(cacheOnly, "selected", "semantic-evaluation").detail, /base rank without waiting/);

  const failingEvaluator: LlmEvaluator = {
    enabled: true,
    name: "failing-semantic-v1",
    async assess() { throw new Error("expected test failure"); },
  };
  const warning = context.mock.method(console, "warn", () => undefined);
  const failingFeed = new RankFeed(repository, new ClassicRankingAlgorithm(), failingEvaluator, 0.3, 10, 1);
  const failed = await failingFeed.execute("processing-failure", "Processing failure", { limit: 10 });
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(stage(failed, "selected", "semantic-evaluation").status, "failed");
  assert.match(stage(failed, "selected", "semantic-evaluation").detail, /base score used/);
});

function article(externalId: string, contentStatus: IncomingArticle["contentStatus"], popularity: number): IncomingArticle {
  return {
    source: "processing-source",
    sourceLabel: "Processing Source",
    sourceQuality: 0.8,
    externalId,
    url: `https://example.com/${externalId}`,
    title: externalId,
    summary: "Summary",
    content: contentStatus === "extracted" ? "A complete article body for semantic processing." : "",
    contentStatus,
    author: null,
    tags: ["architecture"],
    imageUrl: null,
    popularity,
    publishedAt: new Date().toISOString(),
  };
}

function stage(
  ranked: Awaited<ReturnType<RankFeed["execute"]>>,
  externalId: string,
  key: ProcessingStage["key"],
): ProcessingStage {
  const item = ranked.find((candidate) => candidate.article.externalId === externalId);
  assert.ok(item, `Missing ranked article ${externalId}`);
  const result = item.processing.find((candidate) => candidate.key === key);
  assert.ok(result, `Missing ${key} stage for ${externalId}`);
  return result;
}
