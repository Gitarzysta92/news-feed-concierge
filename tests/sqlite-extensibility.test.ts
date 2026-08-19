import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";

test("SQLite persists arbitrary source metadata and edge-neutral deliveries", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "news-concierge-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = new SqliteConciergeRepository(join(directory, "concierge.sqlite"));
  await repository.initialize();
  await repository.ensureChannel("channel", "Channel");
  const inserted = await repository.upsertArticle({
    source: "custom-source",
    sourceLabel: "Custom Source",
    sourceQuality: 0.91,
    externalId: "article-1",
    url: "https://example.com/article-1",
    title: "Custom article",
    summary: "Summary",
    content: "Content",
    contentStatus: "extracted",
    author: null,
    tags: [],
    imageUrl: null,
    popularity: 1,
    publishedAt: new Date().toISOString(),
  });
  assert.equal(inserted.article.sourceLabel, "Custom Source");
  assert.equal(inserted.article.sourceQuality, 0.91);

  await repository.updateSourceMetadata("custom-source", "Renamed Source", 0.77);
  const updated = await repository.findArticle(inserted.article.id);
  assert.equal(updated?.sourceLabel, "Renamed Source");
  assert.equal(updated?.sourceQuality, 0.77);

  await repository.recordDelivery({
    channelId: "channel",
    articleId: inserted.article.id,
    interface: "webhook",
    externalMessageId: "message-1",
    reason: "command",
  });
  assert.equal(await repository.hasDelivery("channel", inserted.article.id, "webhook"), true);
  assert.equal(await repository.hasDelivery("channel", inserted.article.id, "discord"), false);

  const target = await repository.upsertDeliveryTarget({
    interface: "discord",
    channelId: "discord-channel",
    channelName: "engineering",
    installationId: "discord-guild",
  });
  assert.deepEqual(
    {
      interface: target.interface,
      channelId: target.channelId,
      channelName: target.channelName,
      installationId: target.installationId,
    },
    {
      interface: "discord",
      channelId: "discord-channel",
      channelName: "engineering",
      installationId: "discord-guild",
    },
  );
  assert.equal((await repository.listDeliveryTargets("discord")).length, 1);
  assert.equal((await repository.listDeliveryTargets("webhook")).length, 0);
  assert.equal(await repository.removeDeliveryTarget("discord", "discord-channel"), true);
  assert.equal(await repository.removeDeliveryTarget("discord", "discord-channel"), false);
  assert.equal((await repository.listDeliveryTargets("discord")).length, 0);
});
