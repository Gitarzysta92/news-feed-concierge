import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeliverFeed } from "../src/application/deliver-feed.js";
import { RankFeed } from "../src/application/rank-feed.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import type { IncomingArticle } from "../src/domain/model.js";
import type { DeliveryEdge, LlmEvaluator } from "../src/domain/ports.js";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("Discord delivery uses base ranking immediately and does not wait for the model", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-delivery-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();
  await repository.upsertArticle(article("must-read"));

  let assessCalls = 0;
  const hangingEvaluator: LlmEvaluator = {
    enabled: true,
    name: "hanging-ollama",
    async assess() {
      assessCalls += 1;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        timer.unref();
      });
      return null;
    },
  };
  const rankFeed = new RankFeed(
    repository,
    new ClassicRankingAlgorithm(),
    hangingEvaluator,
    0.3,
    10,
    8,
  );
  const scheduled: Array<[string, string]> = [];
  const delivery = new DeliverFeed(
    repository,
    rankFeed,
    undefined,
    (channelId, channelName) => scheduled.push([channelId, channelName]),
  );
  const published: string[] = [];
  const edge: DeliveryEdge = {
    key: "discord",
    async publish(_channelId, item) {
      published.push(item.article.externalId);
      return "message-1";
    },
  };

  const delivered = await Promise.race([
    delivery.execute({
      channelId: "discord-channel",
      channelName: "news",
      edge,
      reason: "command",
    }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("delivery waited for the model")), 1_000);
    }),
  ]);

  assert.equal(assessCalls, 0);
  assert.deepEqual(scheduled, [["discord-channel", "news"]]);
  assert.deepEqual(published, ["must-read"]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.llm, null);
  assert.match(
    delivered[0]?.processing.find((stage) => stage.key === "semantic-evaluation")?.detail ?? "",
    /base rank without waiting/,
  );
});

function article(externalId: string): IncomingArticle {
  return {
    source: "delivery-source",
    sourceLabel: "Delivery Source",
    sourceQuality: 0.9,
    externalId,
    url: `https://example.com/${externalId}`,
    title: externalId,
    summary: "Summary",
    content: "A complete article body for semantic processing.",
    contentStatus: "extracted",
    author: null,
    tags: ["testing"],
    imageUrl: null,
    popularity: 100,
    publishedAt: new Date().toISOString(),
  };
}
