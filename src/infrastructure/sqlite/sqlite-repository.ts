import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { createDefaultProfile } from "../../domain/channel-profile.js";
import type {
  Article,
  ChannelProfile,
  DashboardStats,
  Delivery,
  Feedback,
  IngestionRun,
  IncomingArticle,
  LlmAssessment,
  RankingScore,
  StoredEvaluation,
} from "../../domain/model.js";
import type { ConciergeRepository } from "../../domain/ports.js";

type Row = Record<string, unknown>;

export class SqliteConciergeRepository implements ConciergeRepository {
  private readonly database: Database.Database;

  constructor(filename: string) {
    const absolute = resolve(filename);
    mkdirSync(dirname(absolute), { recursive: true });
    this.database = new Database(absolute);
  }

  async initialize(): Promise<void> {
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_label TEXT NOT NULL,
        source_quality REAL NOT NULL,
        external_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        content TEXT NOT NULL,
        content_status TEXT NOT NULL,
        author TEXT,
        tags_json TEXT NOT NULL,
        image_url TEXT,
        popularity REAL NOT NULL,
        published_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        UNIQUE(source, external_id)
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        weights_json TEXT NOT NULL,
        tag_affinities_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluations (
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        profile_version INTEGER NOT NULL,
        ranking_algorithm TEXT NOT NULL,
        classic_json TEXT NOT NULL,
        llm_json TEXT,
        final_score REAL NOT NULL,
        reason TEXT NOT NULL,
        evaluated_at TEXT NOT NULL,
        PRIMARY KEY(article_id, channel_id)
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        signal REAL NOT NULL,
        interface TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, article_id, actor_id, interface)
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        interface TEXT NOT NULL,
        external_message_id TEXT,
        reason TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        UNIQUE(channel_id, article_id, interface)
      );

      CREATE TABLE IF NOT EXISTS ingestion_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        new_count INTEGER NOT NULL DEFAULT 0,
        extracted_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_evaluations_channel_score ON evaluations(channel_id, final_score DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_channel_updated ON feedback(channel_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_deliveries_channel_date ON deliveries(channel_id, delivered_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_message ON deliveries(external_message_id)
        WHERE external_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON ingestion_runs(started_at DESC);
    `);
    ensureColumn(this.database, "articles", "source_label", "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.database, "articles", "source_quality", "REAL NOT NULL DEFAULT 0.5");
    ensureColumn(
      this.database,
      "evaluations",
      "ranking_algorithm",
      "TEXT NOT NULL DEFAULT 'interpretable-linear-v1'",
    );
    this.database.prepare("UPDATE articles SET source_label = source WHERE source_label = ''").run();
    this.database.pragma("optimize");
  }

  async upsertArticle(input: IncomingArticle): Promise<{ article: Article; inserted: boolean }> {
    const existing = this.database
      .prepare("SELECT id FROM articles WHERE source = ? AND external_id = ?")
      .get(input.source, input.externalId) as Row | undefined;
    const id = existing ? String(existing.id) : `${input.source}:${input.externalId}`;
    const fetchedAt = new Date().toISOString();

    this.database.prepare(`
      INSERT INTO articles (
        id, source, source_label, source_quality, external_id, url, title, summary, content, content_status,
        author, tags_json, image_url, popularity, published_at, fetched_at
      ) VALUES (
        @id, @source, @sourceLabel, @sourceQuality, @externalId, @url, @title, @summary, @content, @contentStatus,
        @author, @tagsJson, @imageUrl, @popularity, @publishedAt, @fetchedAt
      )
      ON CONFLICT(source, external_id) DO UPDATE SET
        source_label = excluded.source_label,
        source_quality = excluded.source_quality,
        url = excluded.url,
        title = excluded.title,
        summary = excluded.summary,
        content = CASE
          WHEN excluded.content_status = 'extracted' OR articles.content_status != 'extracted'
          THEN excluded.content ELSE articles.content END,
        content_status = CASE
          WHEN excluded.content_status = 'extracted' OR articles.content_status != 'extracted'
          THEN excluded.content_status ELSE articles.content_status END,
        author = excluded.author,
        tags_json = excluded.tags_json,
        image_url = COALESCE(excluded.image_url, articles.image_url),
        popularity = excluded.popularity,
        published_at = excluded.published_at,
        fetched_at = excluded.fetched_at
    `).run({ ...input, id, fetchedAt, tagsJson: JSON.stringify(input.tags) });

    const article = await this.findArticle(id);
    if (!article) throw new Error(`Article ${id} disappeared after upsert`);
    return { article, inserted: !existing };
  }

  async updateSourceMetadata(source: string, label: string, quality: number): Promise<void> {
    const changed = this.database.prepare(`
      SELECT 1 FROM articles
      WHERE source = ? AND (source_label != ? OR source_quality != ?)
      LIMIT 1
    `).get(source, label, quality);
    if (!changed) return;
    const transaction = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE articles SET source_label = ?, source_quality = ? WHERE source = ?
      `).run(label, quality, source);
      this.database.prepare(`
        DELETE FROM evaluations WHERE article_id IN (SELECT id FROM articles WHERE source = ?)
      `).run(source);
    });
    transaction();
  }

  async findArticle(id: string): Promise<Article | null> {
    const row = this.database.prepare("SELECT * FROM articles WHERE id = ?").get(id) as Row | undefined;
    return row ? articleFromRow(row) : null;
  }

  async listArticles(limit: number): Promise<Article[]> {
    const rows = this.database.prepare("SELECT * FROM articles ORDER BY published_at DESC LIMIT ?").all(limit) as Row[];
    return rows.map(articleFromRow);
  }

  async listRecentlyDeliveredArticles(channelId: string, limit: number): Promise<Article[]> {
    const rows = this.database.prepare(`
      SELECT a.* FROM deliveries d
      JOIN articles a ON a.id = d.article_id
      WHERE d.channel_id = ?
      ORDER BY d.delivered_at DESC
      LIMIT ?
    `).all(channelId, limit) as Row[];
    return rows.map(articleFromRow);
  }

  async ensureChannel(id: string, name: string): Promise<ChannelProfile> {
    const existing = await this.findChannel(id);
    if (existing) {
      if (existing.name !== name) {
        existing.name = name;
        await this.saveChannel(existing);
      }
      return existing;
    }
    const profile = createDefaultProfile(id, name);
    await this.saveChannel(profile);
    return profile;
  }

  async findChannel(id: string): Promise<ChannelProfile | null> {
    const row = this.database.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
    return row ? channelFromRow(row) : null;
  }

  async listChannels(): Promise<ChannelProfile[]> {
    return (this.database.prepare("SELECT * FROM channels ORDER BY name").all() as Row[]).map(channelFromRow);
  }

  async saveChannel(profile: ChannelProfile): Promise<void> {
    this.database.prepare(`
      INSERT INTO channels (id, name, weights_json, tag_affinities_json, version, updated_at)
      VALUES (@id, @name, @weightsJson, @tagAffinitiesJson, @version, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        weights_json = excluded.weights_json,
        tag_affinities_json = excluded.tag_affinities_json,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run({
      ...profile,
      weightsJson: JSON.stringify(profile.weights),
      tagAffinitiesJson: JSON.stringify(profile.tagAffinities),
    });
  }

  async findEvaluation(articleId: string, channelId: string, profileVersion: number): Promise<StoredEvaluation | null> {
    const row = this.database.prepare(`
      SELECT * FROM evaluations
      WHERE article_id = ? AND channel_id = ? AND profile_version = ?
    `).get(articleId, channelId, profileVersion) as Row | undefined;
    return row ? evaluationFromRow(row) : null;
  }

  async saveEvaluation(evaluation: StoredEvaluation): Promise<void> {
    this.database.prepare(`
      INSERT INTO evaluations (
        article_id, channel_id, profile_version, ranking_algorithm, classic_json, llm_json,
        final_score, reason, evaluated_at
      ) VALUES (
        @articleId, @channelId, @profileVersion, @rankingAlgorithm, @classicJson, @llmJson,
        @finalScore, @reason, @evaluatedAt
      )
      ON CONFLICT(article_id, channel_id) DO UPDATE SET
        profile_version = excluded.profile_version,
        ranking_algorithm = excluded.ranking_algorithm,
        classic_json = excluded.classic_json,
        llm_json = excluded.llm_json,
        final_score = excluded.final_score,
        reason = excluded.reason,
        evaluated_at = excluded.evaluated_at
    `).run({
      ...evaluation,
      classicJson: JSON.stringify(evaluation.base),
      llmJson: evaluation.llm ? JSON.stringify(evaluation.llm) : null,
    });
  }

  async invalidateEvaluations(channelId: string): Promise<void> {
    this.database.prepare("DELETE FROM evaluations WHERE channel_id = ?").run(channelId);
  }

  async upsertFeedback(input: Parameters<ConciergeRepository["upsertFeedback"]>[0]): Promise<{ feedback: Feedback; previous: Feedback | null }> {
    const previousRow = this.database.prepare(`
      SELECT * FROM feedback
      WHERE channel_id = ? AND article_id = ? AND actor_id = ? AND interface = ?
    `).get(input.channelId, input.articleId, input.actorId, input.interface) as Row | undefined;
    const previous = previousRow ? feedbackFromRow(previousRow) : null;
    const now = new Date().toISOString();
    const id = previous?.id ?? randomUUID();
    const createdAt = previous?.createdAt ?? now;

    this.database.prepare(`
      INSERT INTO feedback (
        id, channel_id, article_id, actor_id, reaction, signal, interface, created_at, updated_at
      ) VALUES (
        @id, @channelId, @articleId, @actorId, @reaction, @signal, @interface, @createdAt, @updatedAt
      )
      ON CONFLICT(channel_id, article_id, actor_id, interface) DO UPDATE SET
        reaction = excluded.reaction,
        signal = excluded.signal,
        updated_at = excluded.updated_at
    `).run({ ...input, id, createdAt, updatedAt: now });

    return {
      feedback: { ...input, id, createdAt, updatedAt: now },
      previous,
    };
  }

  async hasDelivery(channelId: string, articleId: string, deliveryInterface: string): Promise<boolean> {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM deliveries WHERE channel_id = ? AND article_id = ? AND interface = ?
    `).get(channelId, articleId, deliveryInterface));
  }

  async recordDelivery(input: Parameters<ConciergeRepository["recordDelivery"]>[0]): Promise<Delivery> {
    const delivery: Delivery = {
      ...input,
      id: randomUUID(),
      deliveredAt: new Date().toISOString(),
    };
    this.database.prepare(`
      INSERT OR IGNORE INTO deliveries (
        id, channel_id, article_id, interface, external_message_id, reason, delivered_at
      ) VALUES (
        @id, @channelId, @articleId, @interface, @externalMessageId, @reason, @deliveredAt
      )
    `).run(delivery);
    const row = this.database.prepare(`
      SELECT * FROM deliveries WHERE channel_id = ? AND article_id = ? AND interface = ?
    `).get(input.channelId, input.articleId, input.interface) as Row;
    return deliveryFromRow(row);
  }

  async findDeliveryByMessageId(messageId: string): Promise<Delivery | null> {
    const row = this.database.prepare("SELECT * FROM deliveries WHERE external_message_id = ?").get(messageId) as Row | undefined;
    return row ? deliveryFromRow(row) : null;
  }

  async startRun(source: string): Promise<IngestionRun> {
    const run: IngestionRun = {
      id: randomUUID(),
      source,
      status: "running",
      fetchedCount: 0,
      newCount: 0,
      extractedCount: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.database.prepare(`
      INSERT INTO ingestion_runs (
        id, source, status, fetched_count, new_count, extracted_count, error, started_at, finished_at
      ) VALUES (
        @id, @source, @status, @fetchedCount, @newCount, @extractedCount, @error, @startedAt, @finishedAt
      )
    `).run(run);
    return run;
  }

  async finishRun(id: string, result: Parameters<ConciergeRepository["finishRun"]>[1]): Promise<void> {
    this.database.prepare(`
      UPDATE ingestion_runs SET
        status = @status,
        fetched_count = @fetchedCount,
        new_count = @newCount,
        extracted_count = @extractedCount,
        error = @error,
        finished_at = @finishedAt
      WHERE id = @id
    `).run({ ...result, id, error: result.error ?? null, finishedAt: new Date().toISOString() });
  }

  async listRuns(limit: number): Promise<IngestionRun[]> {
    return (this.database.prepare("SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Row[])
      .map(runFromRow);
  }

  async stats(): Promise<DashboardStats> {
    const counts = this.database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM articles) AS articles,
        (SELECT COUNT(*) FROM articles WHERE content_status = 'extracted') AS extracted,
        (SELECT COUNT(*) FROM evaluations) AS evaluations,
        (SELECT COUNT(*) FROM deliveries) AS deliveries,
        (SELECT COUNT(*) FROM feedback) AS feedback,
        (SELECT COUNT(*) FROM channels) AS channels
    `).get() as Row;
    return {
      articles: Number(counts.articles),
      extracted: Number(counts.extracted),
      evaluations: Number(counts.evaluations),
      deliveries: Number(counts.deliveries),
      feedback: Number(counts.feedback),
      channels: Number(counts.channels),
    };
  }
}

function articleFromRow(row: Row): Article {
  return {
    id: String(row.id),
    source: row.source as Article["source"],
    sourceLabel: String(row.source_label),
    sourceQuality: Number(row.source_quality),
    externalId: String(row.external_id),
    url: String(row.url),
    title: String(row.title),
    summary: String(row.summary),
    content: String(row.content),
    contentStatus: row.content_status as Article["contentStatus"],
    author: row.author ? String(row.author) : null,
    tags: JSON.parse(String(row.tags_json)) as string[],
    imageUrl: row.image_url ? String(row.image_url) : null,
    popularity: Number(row.popularity),
    publishedAt: String(row.published_at),
    fetchedAt: String(row.fetched_at),
  };
}

function channelFromRow(row: Row): ChannelProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    weights: JSON.parse(String(row.weights_json)) as ChannelProfile["weights"],
    tagAffinities: JSON.parse(String(row.tag_affinities_json)) as Record<string, number>,
    version: Number(row.version),
    updatedAt: String(row.updated_at),
  };
}

function evaluationFromRow(row: Row): StoredEvaluation {
  return {
    articleId: String(row.article_id),
    channelId: String(row.channel_id),
    profileVersion: Number(row.profile_version),
    rankingAlgorithm: String(row.ranking_algorithm),
    base: JSON.parse(String(row.classic_json)) as RankingScore,
    llm: row.llm_json ? JSON.parse(String(row.llm_json)) as LlmAssessment : null,
    finalScore: Number(row.final_score),
    reason: String(row.reason),
    evaluatedAt: String(row.evaluated_at),
  };
}

function ensureColumn(
  database: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function feedbackFromRow(row: Row): Feedback {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    articleId: String(row.article_id),
    actorId: String(row.actor_id),
    reaction: row.reaction as Feedback["reaction"],
    signal: Number(row.signal),
    interface: row.interface as Feedback["interface"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function deliveryFromRow(row: Row): Delivery {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    articleId: String(row.article_id),
    interface: String(row.interface),
    externalMessageId: row.external_message_id ? String(row.external_message_id) : null,
    reason: row.reason as Delivery["reason"],
    deliveredAt: String(row.delivered_at),
  };
}

function runFromRow(row: Row): IngestionRun {
  return {
    id: String(row.id),
    source: String(row.source),
    status: row.status as IngestionRun["status"],
    fetchedCount: Number(row.fetched_count),
    newCount: Number(row.new_count),
    extractedCount: Number(row.extracted_count),
    error: row.error ? String(row.error) : null,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
  };
}
