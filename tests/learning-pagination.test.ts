import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RankFeed } from "../src/application/rank-feed.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import type { IncomingArticle } from "../src/domain/model.js";
import type { LlmEvaluator } from "../src/domain/ports.js";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("learning articles are paginated newest-first and can exclude the current user's ratings", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-learning-page-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();

  const articles = await Promise.all([
    repository.upsertArticle(article("newest", "2026-08-20T12:00:00.000Z", 1)),
    repository.upsertArticle(article("second", "2026-08-20T11:00:00.000Z", 5)),
    repository.upsertArticle(article("third", "2026-08-20T10:00:00.000Z", 50)),
    repository.upsertArticle(article("oldest", "2026-08-20T09:00:00.000Z", 5_000)),
  ]);
  const user = await repository.ensureUser({ kind: "anonymous" });
  const otherUser = await repository.ensureUser({ kind: "anonymous" });
  await repository.ensureChannel("learning", "Learning");
  await repository.upsertFeedback({
    channelId: "learning",
    articleId: articles[0].article.id,
    userId: user.id,
    reaction: "👍",
    signal: 1,
    interface: "admin",
  });

  const firstPage = await repository.listArticlePage({ limit: 2, offset: 0 });
  const secondPage = await repository.listArticlePage({ limit: 2, offset: 2 });
  assert.equal(firstPage.total, 4);
  assert.deepEqual(firstPage.articles.map((item) => item.externalId), ["newest", "second"]);
  assert.deepEqual(secondPage.articles.map((item) => item.externalId), ["third", "oldest"]);

  const unrated = await repository.listArticlePage({
    limit: 2,
    offset: 0,
    unratedBy: { channelId: "learning", userId: user.id, interface: "admin" },
  });
  assert.equal(unrated.total, 3);
  assert.deepEqual(unrated.articles.map((item) => item.externalId), ["second", "third"]);

  const independentUser = await repository.listArticlePage({
    limit: 2,
    offset: 0,
    unratedBy: { channelId: "learning", userId: otherUser.id, interface: "admin" },
  });
  assert.equal(independentUser.total, 4);
  assert.equal(independentUser.articles[0]?.externalId, "newest");

  const feed = new RankFeed(repository, new ClassicRankingAlgorithm(), disabledLlm());
  const evaluated = await feed.executeLatestPage("learning", "Learning", {
    page: 1,
    pageSize: 2,
    semanticMode: "cached-only",
  });
  assert.equal(evaluated.totalPages, 2);
  assert.deepEqual(evaluated.items.map((item) => item.article.externalId), ["newest", "second"]);
});

function article(externalId: string, publishedAt: string, popularity: number): IncomingArticle {
  return {
    source: "pagination-source",
    sourceLabel: "Pagination Source",
    sourceQuality: 0.8,
    externalId,
    url: `https://example.com/${externalId}`,
    title: externalId,
    summary: "Summary",
    content: "Complete article text for ranking.",
    contentStatus: "extracted",
    author: null,
    tags: ["testing"],
    imageUrl: null,
    popularity,
    publishedAt,
  };
}

function disabledLlm(): LlmEvaluator {
  return {
    enabled: false,
    name: "disabled",
    async assess() { return null; },
  };
}
