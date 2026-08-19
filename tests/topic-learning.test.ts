import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RebuildChannelProfile } from "../src/application/rebuild-channel-profile.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import { inferArticleTags, inferTags } from "../src/domain/tag-inference.js";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("topic inference uses whole terms and meaningful title fallbacks", () => {
  assert.deepEqual(inferTags("The maintainer said the release is ready"), []);
  assert.ok(inferArticleTags("OpenRouter joins Stripe", "A marketplace for every AI model").includes("ai"));
  assert.ok(inferArticleTags("Geometry on a remote islet", "No classified topic applies").includes("geometry"));
});

test("profile rebuild derives affinities from current reactions and preserves inferred article tags", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-topics-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();
  await repository.ensureChannel("learning", "Learning");
  const user = await repository.ensureUser({ kind: "anonymous" });
  const inserted = await repository.upsertArticle({
    source: "test-source",
    sourceLabel: "Test Source",
    sourceQuality: 0.8,
    externalId: "openrouter",
    url: "https://example.com/openrouter",
    title: "OpenRouter joins Stripe",
    summary: "A marketplace for AI models",
    content: "OpenRouter lets developers route requests to many AI models through one interface.",
    contentStatus: "extracted",
    author: null,
    tags: [],
    imageUrl: null,
    popularity: 20,
    publishedAt: new Date().toISOString(),
  });
  await repository.upsertFeedback({
    channelId: "learning",
    articleId: inserted.article.id,
    userId: user.id,
    reaction: "👍",
    signal: 1,
    interface: "admin",
  });
  const rebuild = new RebuildChannelProfile(repository, new ClassicRankingAlgorithm());
  const positive = await rebuild.execute("learning", "Learning");

  assert.equal(positive.changed, true);
  assert.ok(positive.profile.tagAffinities.ai > 0);
  assert.ok((await repository.findArticle(inserted.article.id))?.tags.includes("ai"));

  const enriched = await repository.findArticle(inserted.article.id);
  assert.ok(enriched);
  const { id, fetchedAt, ...incoming } = enriched;
  void id;
  void fetchedAt;
  await repository.upsertArticle({ ...incoming, content: "", contentStatus: "failed", tags: [] });
  assert.ok((await repository.findArticle(inserted.article.id))?.tags.includes("ai"));

  await repository.upsertFeedback({
    channelId: "learning",
    articleId: inserted.article.id,
    userId: user.id,
    reaction: "👎",
    signal: -1,
    interface: "admin",
  });
  const negative = await rebuild.execute("learning", "Learning");
  assert.ok(negative.profile.tagAffinities.ai < 0);
  assert.equal((await rebuild.execute("learning", "Learning")).changed, false);
});
