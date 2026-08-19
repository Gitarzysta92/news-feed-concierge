import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("anonymous users retain independent reaction state", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-users-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();
  await repository.ensureChannel("dashboard", "Dashboard");
  const { article } = await repository.upsertArticle({
    source: "test-source",
    sourceLabel: "Test Source",
    sourceQuality: 0.8,
    externalId: "article-1",
    url: "https://example.com/article-1",
    title: "An article worth rating",
    summary: "Summary",
    content: "Full article text",
    contentStatus: "extracted",
    author: null,
    tags: ["testing"],
    imageUrl: null,
    popularity: 1,
    publishedAt: new Date().toISOString(),
  });
  const first = await repository.ensureUser({ kind: "anonymous" });
  const second = await repository.ensureUser({ kind: "anonymous" });

  await repository.upsertFeedback({
    channelId: "dashboard",
    articleId: article.id,
    userId: first.id,
    reaction: "👍",
    signal: 1,
    interface: "admin",
  });
  await repository.upsertFeedback({
    channelId: "dashboard",
    articleId: article.id,
    userId: second.id,
    reaction: "👎",
    signal: -1,
    interface: "admin",
  });

  assert.notEqual(first.id, second.id);
  assert.equal(first.name, `Visitor ${first.id.slice(0, 8).toUpperCase()}`);
  assert.equal((await repository.listUserFeedback("dashboard", first.id, "admin"))[0]?.reaction, "👍");
  assert.equal((await repository.listUserFeedback("dashboard", second.id, "admin"))[0]?.reaction, "👎");
  assert.equal((await repository.ensureUser({ id: first.id, kind: "anonymous" })).createdAt, first.createdAt);
  assert.equal((await repository.updateUserName(first.id, "Ada Lovelace")).name, "Ada Lovelace");
  assert.equal((await repository.ensureUser({ id: first.id, kind: "anonymous" })).name, "Ada Lovelace");
  assert.equal((await repository.listUsers(10)).find((user) => user.id === first.id)?.name, "Ada Lovelace");
});
