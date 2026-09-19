import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PostgresDatabase } from "../src/infrastructure/postgres/database.js";
import { migrate } from "../src/infrastructure/postgres/migrate.js";
import { PostgresConciergeRepository } from "../src/infrastructure/postgres/postgres-repository.js";
import { PostgresWorkflowStore } from "../src/infrastructure/postgres/workflow-store.js";
import { importSqlite } from "../src/infrastructure/postgres/import-sqlite.js";
import { SqliteConciergeRepository } from "../src/infrastructure/sqlite/sqlite-repository.js";
import { SubmitFeedback } from "../src/application/submit-feedback.js";
import { RebuildChannelProfile } from "../src/application/rebuild-channel-profile.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import { RankFeed } from "../src/application/rank-feed.js";
import { DeliverFeed } from "../src/application/deliver-feed.js";
import { DisabledLlmEvaluator } from "../src/infrastructure/llm/openai-article-evaluator.js";
import { Workflows } from "../src/application/workflows.js";
import { LiveInference } from "../src/bootstrap/live-inference.js";

const article = {
  source: "test",
  sourceLabel: "Test",
  sourceQuality: 0.91,
  externalId: "a",
  url: "https://example.com/a",
  title: "TypeScript architecture",
  summary: "Summary",
  content: "TypeScript application architecture",
  contentStatus: "extracted" as const,
  author: null,
  tags: ["typescript"],
  imageUrl: null,
  popularity: 1,
  publishedAt: new Date().toISOString(),
};

test(
  "PostgreSQL persistence, concurrency, workflows and SQLite import",
  { skip: !process.env.TEST_DATABASE_URL },
  async (context) => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const admin = new PostgresDatabase(url.href);
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new PostgresDatabase(url.href);
    context.after(async () => {
      await db.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    });
    await Promise.all([migrate(db), migrate(db)]);
    const repository = new PostgresConciergeRepository(db);
    await repository.initialize();
    await context.test("inference settings persist across server instances with encrypted credentials", async () => {
      const key = randomBytes(32).toString("hex");
      const defaults = {
        enabled: true, baseUrl: "http://model:11434/v1", model: "initial",
        revision: "1", timeoutMs: 120000, weight: 0.3, candidateLimit: 2,
        apiKey: "initial-key",
      };
      const current = new LiveInference(db, defaults, key);
      await current.initialize();
      await current.update({
        enabled: true, baseUrl: "https://example.test/v1", model: "replacement",
        revision: "2", timeoutMs: 30000, weight: 0.6, candidateLimit: 3,
        apiKey: "replacement-key",
      });
      const row = await db.query<{ encrypted_api_key: string }>("SELECT encrypted_api_key FROM inference_settings WHERE id=1");
      assert.equal(row.rows.length, 1);
      assert.equal(row.rows[0].encrypted_api_key.includes("replacement-key"), false);
      const restarted = new LiveInference(db, defaults, key);
      await restarted.initialize();
      assert.equal(restarted.activeEvaluator.name, "replacement@2");
      assert.equal(restarted.activeWeight, 0.6);
      assert.equal(restarted.snapshot().hasApiKey, true);
    });
    await context.test(
      "repository preserves data and serializes concurrent feedback",
      async () => {
        const upserts = await Promise.all([
          repository.upsertArticle(article),
          repository.upsertArticle(article),
        ]);
        assert.equal(upserts.filter((r) => r.inserted).length, 1);
        const id = upserts[0].article.id;
        assert.equal((await repository.findArticle(id))?.sourceQuality, 0.91);
        await repository.upsertArticle({
          ...article,
          content: "",
          tags: [],
          contentStatus: "source-only",
        });
        assert.equal(
          (await repository.findArticle(id))?.content,
          article.content,
        );
        await Promise.all([
          repository.ensureChannel("c", "Channel"),
          repository.ensureChannel("c", "Channel"),
        ]);
        const algorithm = new ClassicRankingAlgorithm();
        const feedback = new SubmitFeedback(
          repository,
          algorithm,
          new RebuildChannelProfile(repository, algorithm),
        );
        await Promise.all(
          ["u1", "u2"].map((userId) =>
            feedback.execute({
              channelId: "c",
              channelName: "Channel",
              articleId: id,
              userId,
              reaction: "🔥",
              interface: "admin",
            }),
          ),
        );
        assert.equal((await repository.listChannelFeedback("c")).length, 2);
        assert.equal(
          (await repository.listUserFeedback("c", "u1", "admin")).length,
          1,
        );
        assert.equal(
          (
            await repository.listArticlePage({
              limit: 10,
              offset: 0,
              unratedBy: { channelId: "c", userId: "u1", interface: "admin" },
            })
          ).total,
          0,
        );
        assert.equal(
          (await repository.listArticlePage({ limit: 10, offset: 0 })).total,
          1,
        );
        await repository.updateUserName("u1", "Named user");
        assert.ok(
          (await repository.listUsers(10)).some((u) => u.name === "Named user"),
        );
        const channel = await repository.findChannel("c");
        assert.ok(channel);
        await repository.saveEvaluation({
          articleId: id,
          channelId: "c",
          profileVersion: channel.version,
          rankingAlgorithm: algorithm.name,
          base: { score: 0.5, features: {}, contributions: {} },
          llm: null,
          finalScore: 0.5,
          reason: "test",
          evaluatedAt: new Date().toISOString(),
          cacheKey: "current",
        });
        await repository.saveEvaluation({
          articleId: id,
          channelId: "c",
          profileVersion: channel.version - 1,
          rankingAlgorithm: algorithm.name,
          base: { score: 0.1, features: {}, contributions: {} },
          llm: null,
          finalScore: 0.1,
          reason: "stale",
          evaluatedAt: new Date().toISOString(),
        });
        assert.equal(
          (await repository.findEvaluation(id, "c", channel.version))?.cacheKey,
          "current",
        );
        await repository.updateSourceMetadata("test", "Renamed", 0.8);
        assert.equal(
          await repository.findEvaluation(id, "c", channel.version),
          null,
        );
        const target = await repository.upsertDeliveryTarget({
          channelId: "c",
          channelName: "Channel",
          interface: "discord",
          installationId: "guild",
        });
        assert.equal(target.installationId, "guild");
        assert.equal(
          (await repository.listDeliveryTargets("discord")).length,
          1,
        );
        const run = await repository.startRun("test");
        await repository.finishRun(run.id, {
          status: "completed",
          fetchedCount: 1,
          newCount: 1,
          extractedCount: 1,
        });
        assert.equal((await repository.listRuns(1))[0].status, "completed");
        assert.equal((await repository.stats()).feedback, 2);
        const reopened = new PostgresConciergeRepository(
          new PostgresDatabase(url.href),
        );
        try {
          assert.equal((await reopened.findArticle(id))?.title, article.title);
        } finally {
          await reopened.close();
        }
      },
    );
    await context.test(
      "delivery intent blocks concurrent and uncertain external sends",
      async () => {
        const algorithm = new ClassicRankingAlgorithm();
        const ranker = new RankFeed(
          repository,
          algorithm,
          new DisabledLlmEvaluator(),
        );
        const delivery = new DeliverFeed(repository, ranker);
        let sends = 0;
        const edge = {
          key: "test-edge",
          async publish() {
            sends++;
            throw new Error("Connection lost after send");
          },
        };
        await assert.rejects(() =>
          delivery.execute({
            channelId: "c",
            channelName: "Channel",
            edge,
            reason: "command",
          }),
        );
        await delivery.execute({
          channelId: "c",
          channelName: "Channel",
          edge,
          reason: "command",
        });
        assert.equal(sends, 1);
        const row = (
          await db.query(
            "SELECT status FROM delivery_intents WHERE interface='test-edge'",
          )
        ).rows[0];
        assert.equal(row.status, "uncertain");
        const claims = await Promise.all([
          repository.claimDelivery("c", "test:a", "other"),
          repository.claimDelivery("c", "test:a", "other"),
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        await repository.recordDelivery({
          channelId: "c",
          articleId: "test:a",
          interface: "other",
          externalMessageId: "m1",
          reason: "command",
        });
        assert.equal(
          await repository.hasDelivery("c", "test:a", "other"),
          true,
        );
        assert.equal(
          (await repository.findDeliveryByMessageId("m1"))?.articleId,
          "test:a",
        );
        assert.equal(
          (await repository.listRecentlyDeliveredArticles("c", 10)).length,
          1,
        );
      },
    );
    await context.test(
      "jobs deduplicate, survive worker loss, fence stale owners and retry",
      async () => {
        const store = new PostgresWorkflowStore(db);
        const ids = await Promise.all([
          store.enqueue("ingestion", {}, "ingestion"),
          store.enqueue("ingestion", {}, "ingestion"),
        ]);
        assert.equal(ids[0], ids[1]);
        const claims = await Promise.all([
          store.claim("old"),
          store.claim("other"),
        ]);
        assert.equal(claims.filter(Boolean).length, 1);
        await db.query(
          "UPDATE workflow_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
          [ids[0]],
        );
        const recovered = await store.claim("new");
        assert.equal(recovered?.id, ids[0]);
        await store.finish(ids[0], "old");
        assert.equal(
          (
            await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [
              ids[0],
            ])
          ).rows[0].status,
          "running",
        );
        assert.equal(await store.renew(ids[0], "new"), true);
        await store.finish(ids[0], "new", "retry me");
        assert.equal(
          (
            await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [
              ids[0],
            ])
          ).rows[0].status,
          "queued",
        );
        await db.query(
          "UPDATE workflow_jobs SET next_attempt_at=now() WHERE id=$1",
          [ids[0]],
        );
        const worker = new Workflows(store);
        let runs = 0;
        worker.register("ingestion", async () => {
          runs++;
        });
        await worker.runOnce();
        assert.equal(runs, 1);
        assert.equal(
          (
            await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [
              ids[0],
            ])
          ).rows[0].status,
          "completed",
        );
        const snapshot = await store.snapshot();
        assert.ok(
          snapshot.actions.some(
            (a) => a.id === ids[0] && a.status === "completed",
          ),
        );
      },
    );
    await context.test(
      "import uses an empty target and preserves identifiers",
      async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "concierge-import-test-"),
        );
        const sqlite = new SqliteConciergeRepository(
          join(directory, "source.sqlite"),
        );
        try {
          await sqlite.initialize();
          await sqlite.upsertArticle(article);
          await sqlite.ensureChannel("import-channel", "Imported");
          await assert.rejects(
            () => importSqlite(join(directory, "source.sqlite"), db),
            /empty target/,
          );
          await db.query(
            "TRUNCATE articles,channels,users,ingestion_runs,workflow_jobs,activity CASCADE",
          );
          const counts = await importSqlite(
            join(directory, "source.sqlite"),
            db,
          );
          assert.equal(counts.articles, 1);
          assert.equal(
            (await repository.findArticle("test:a"))?.title,
            article.title,
          );
          assert.equal(
            (await repository.findChannel("import-channel"))?.name,
            "Imported",
          );
        } finally {
          await sqlite.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  },
);
