import { randomUUID } from "node:crypto";
import { createDefaultProfile } from "../../domain/channel-profile.js";
import type {
  ChannelProfile,
  IncomingArticle,
  StoredEvaluation,
} from "../../domain/model.js";
import type {
  ArticlePageQuery,
  ConciergeRepository,
} from "../../domain/ports.js";
import {
  articleFromRow,
  channelFromRow,
  defaultUserName,
  deliveryFromRow,
  deliveryTargetFromRow,
  evaluationFromRow,
  feedbackFromRow,
  runFromRow,
  userFromRow,
} from "../persistence/row-mappers.js";
import { PostgresDatabase } from "./database.js";
import { checkSchema } from "./migrate.js";

export class PostgresConciergeRepository implements ConciergeRepository {
  constructor(readonly database: PostgresDatabase) {}
  async initialize() {
    await checkSchema(this.database);
  }
  async close() {
    await this.database.close();
  }

  async withChannelLock<T>(
    channelId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(async () => {
      await this.database.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`channel:${channelId}`],
      );
      return work();
    });
  }

  async upsertArticle(input: IncomingArticle) {
    return this.database.transaction(async () => {
      await this.database.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`article:${input.source}:${input.externalId}`],
      );
      const existing = (
        await this.database.query(
          "SELECT * FROM articles WHERE source=$1 AND external_id=$2",
          [input.source, input.externalId],
        )
      ).rows[0];
      const id = existing
        ? String(existing.id)
        : `${input.source}:${input.externalId}`;
      const { rows } = await this.database.query(
        `
        INSERT INTO articles (id,source,source_label,source_quality,external_id,url,title,summary,content,content_status,
          author,tags_json,image_url,popularity,published_at,fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
        ON CONFLICT(source,external_id) DO UPDATE SET
          source_label=excluded.source_label, source_quality=excluded.source_quality,
          url=excluded.url, title=excluded.title, summary=excluded.summary,
          content=CASE WHEN excluded.content_status='extracted' OR articles.content_status!='extracted' THEN excluded.content ELSE articles.content END,
          content_status=CASE WHEN excluded.content_status='extracted' OR articles.content_status!='extracted' THEN excluded.content_status ELSE articles.content_status END,
          tags_json=CASE WHEN excluded.content_status='extracted' OR articles.content_status!='extracted' THEN excluded.tags_json ELSE articles.tags_json END,
          author=excluded.author, image_url=COALESCE(excluded.image_url,articles.image_url), popularity=excluded.popularity,
          published_at=excluded.published_at, fetched_at=excluded.fetched_at RETURNING *`,
        [
          id,
          input.source,
          input.sourceLabel,
          input.sourceQuality,
          input.externalId,
          input.url,
          input.title,
          input.summary,
          input.content,
          input.contentStatus,
          input.author,
          JSON.stringify(input.tags),
          input.imageUrl,
          input.popularity,
          input.publishedAt,
        ],
      );
      return { article: articleFromRow(rows[0]), inserted: !existing };
    });
  }

  async updateSourceMetadata(source: string, label: string, quality: number) {
    await this.database.transaction(async () => {
      const changed = await this.database.query(
        `UPDATE articles SET source_label=$2,source_quality=$3
        WHERE source=$1 AND (source_label!=$2 OR source_quality!=$3) RETURNING id`,
        [source, label, quality],
      );
      if (changed.rowCount)
        await this.database.query(
          "DELETE FROM evaluations WHERE article_id=ANY($1::text[])",
          [changed.rows.map((row) => row.id)],
        );
    });
  }

  async findArticle(id: string) {
    const { rows } = await this.database.query(
      "SELECT * FROM articles WHERE id=$1",
      [id],
    );
    return rows[0] ? articleFromRow(rows[0]) : null;
  }
  async listArticles(limit: number) {
    return (
      await this.database.query(
        "SELECT * FROM articles ORDER BY published_at DESC,id DESC LIMIT $1",
        [limit],
      )
    ).rows.map(articleFromRow);
  }
  async listArticlePage(query: ArticlePageQuery) {
    const values: unknown[] = [];
    let where = "";
    if (query.unratedBy) {
      values.push(
        query.unratedBy.channelId,
        query.unratedBy.userId,
        query.unratedBy.interface,
      );
      where =
        "WHERE NOT EXISTS (SELECT 1 FROM feedback f WHERE f.article_id=a.id AND f.channel_id=$1 AND f.actor_id=$2 AND f.interface=$3)";
    }
    const count = await this.database.query(
      `SELECT count(*) AS total FROM articles a ${where}`,
      values,
    );
    const rows = await this.database.query(
      `SELECT a.* FROM articles a ${where} ORDER BY a.published_at DESC,a.id DESC
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, Math.max(1, query.limit), Math.max(0, query.offset)],
    );
    return {
      articles: rows.rows.map(articleFromRow),
      total: Number(count.rows[0].total),
    };
  }
  async listRecentlyDeliveredArticles(channelId: string, limit: number) {
    return (
      await this.database.query(
        `SELECT a.* FROM deliveries d JOIN articles a ON a.id=d.article_id
      WHERE d.channel_id=$1 ORDER BY d.delivered_at DESC LIMIT $2`,
        [channelId, limit],
      )
    ).rows.map(articleFromRow);
  }
  async ensureChannel(id: string, name: string) {
    const profile = createDefaultProfile(id, name);
    const { rows } = await this.database.query(
      `INSERT INTO channels(id,name,weights_json,tag_affinities_json,version,updated_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name RETURNING *`,
      [
        id,
        name,
        JSON.stringify(profile.weights),
        JSON.stringify(profile.tagAffinities),
        profile.version,
        profile.updatedAt,
      ],
    );
    return channelFromRow(rows[0]);
  }
  async findChannel(id: string) {
    const { rows } = await this.database.query(
      "SELECT * FROM channels WHERE id=$1",
      [id],
    );
    return rows[0] ? channelFromRow(rows[0]) : null;
  }
  async listChannels() {
    return (
      await this.database.query("SELECT * FROM channels ORDER BY name")
    ).rows.map(channelFromRow);
  }
  async saveChannel(profile: ChannelProfile) {
    await this.database.query(
      `INSERT INTO channels(id,name,weights_json,tag_affinities_json,version,updated_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET name=excluded.name, weights_json=excluded.weights_json,
      tag_affinities_json=excluded.tag_affinities_json, version=excluded.version, updated_at=excluded.updated_at
      WHERE channels.version<=excluded.version`,
      [
        profile.id,
        profile.name,
        JSON.stringify(profile.weights),
        JSON.stringify(profile.tagAffinities),
        profile.version,
        profile.updatedAt,
      ],
    );
  }
  async ensureUser(input: Parameters<ConciergeRepository["ensureUser"]>[0]) {
    const id = input.id ?? randomUUID();
    const { rows } = await this.database.query(
      `INSERT INTO users(id,name,kind,created_at,last_seen_at) VALUES($1,$2,$3,now(),now())
      ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at RETURNING *`,
      [id, input.name?.trim() || defaultUserName(id, input.kind), input.kind],
    );
    return userFromRow(rows[0]);
  }
  async listUsers(limit: number) {
    return (
      await this.database.query(
        "SELECT * FROM users ORDER BY last_seen_at DESC LIMIT $1",
        [limit],
      )
    ).rows.map(userFromRow);
  }
  async updateUserName(id: string, name: string) {
    const normalized = name.trim();
    if (!normalized || normalized.length > 60)
      throw new Error("User name must contain 1 to 60 characters");
    const { rows } = await this.database.query(
      "UPDATE users SET name=$2 WHERE id=$1 RETURNING *",
      [id, normalized],
    );
    if (!rows[0]) throw new Error(`User not found: ${id}`);
    return userFromRow(rows[0]);
  }
  async listUserFeedback(
    channelId: string,
    userId: string,
    feedbackInterface?: string,
  ) {
    return (
      await this.database.query(
        `SELECT * FROM feedback WHERE channel_id=$1 AND actor_id=$2
      AND ($3::text IS NULL OR interface=$3) ORDER BY updated_at DESC`,
        [channelId, userId, feedbackInterface ?? null],
      )
    ).rows.map(feedbackFromRow);
  }
  async listChannelFeedback(channelId: string) {
    return (
      await this.database.query(
        "SELECT * FROM feedback WHERE channel_id=$1 ORDER BY updated_at,id",
        [channelId],
      )
    ).rows.map(feedbackFromRow);
  }
  async findEvaluation(
    articleId: string,
    channelId: string,
    profileVersion: number,
  ) {
    const { rows } = await this.database.query(
      "SELECT * FROM evaluations WHERE article_id=$1 AND channel_id=$2 AND profile_version=$3",
      [articleId, channelId, profileVersion],
    );
    return rows[0] ? evaluationFromRow(rows[0]) : null;
  }
  async saveEvaluation(evaluation: StoredEvaluation) {
    await this.withChannelLock(evaluation.channelId, async () => {
      await this.database.query(
        `INSERT INTO evaluations(article_id,channel_id,profile_version,ranking_algorithm,classic_json,llm_json,final_score,reason,evaluated_at,cache_key)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 FROM channels WHERE id=$2 AND version=$3
        ON CONFLICT(article_id,channel_id) DO UPDATE SET profile_version=excluded.profile_version,ranking_algorithm=excluded.ranking_algorithm,
        classic_json=excluded.classic_json,llm_json=excluded.llm_json,final_score=excluded.final_score,reason=excluded.reason,
        evaluated_at=excluded.evaluated_at,cache_key=excluded.cache_key
        WHERE evaluations.profile_version<=excluded.profile_version`,
        [
          evaluation.articleId,
          evaluation.channelId,
          evaluation.profileVersion,
          evaluation.rankingAlgorithm,
          JSON.stringify(evaluation.base),
          evaluation.llm ? JSON.stringify(evaluation.llm) : null,
          evaluation.finalScore,
          evaluation.reason,
          evaluation.evaluatedAt,
          evaluation.cacheKey ?? null,
        ],
      );
    });
  }
  async invalidateEvaluations(channelId: string) {
    await this.database.query("DELETE FROM evaluations WHERE channel_id=$1", [
      channelId,
    ]);
  }
  async upsertFeedback(
    input: Parameters<ConciergeRepository["upsertFeedback"]>[0],
  ) {
    return this.withChannelLock(input.channelId, async () => {
      const previous = (
        await this.database.query(
          "SELECT * FROM feedback WHERE channel_id=$1 AND article_id=$2 AND actor_id=$3 AND interface=$4",
          [input.channelId, input.articleId, input.userId, input.interface],
        )
      ).rows[0];
      const { rows } = await this.database.query(
        `INSERT INTO feedback(id,channel_id,article_id,actor_id,reaction,signal,interface,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now(),now()) ON CONFLICT(channel_id,article_id,actor_id,interface)
        DO UPDATE SET reaction=excluded.reaction,signal=excluded.signal,updated_at=excluded.updated_at RETURNING *`,
        [
          randomUUID(),
          input.channelId,
          input.articleId,
          input.userId,
          input.reaction,
          input.signal,
          input.interface,
        ],
      );
      return {
        feedback: feedbackFromRow(rows[0]),
        previous: previous ? feedbackFromRow(previous) : null,
      };
    });
  }
  async hasDelivery(
    channelId: string,
    articleId: string,
    deliveryInterface: string,
  ) {
    return Boolean(
      (
        await this.database.query(
          "SELECT 1 FROM deliveries WHERE channel_id=$1 AND article_id=$2 AND interface=$3",
          [channelId, articleId, deliveryInterface],
        )
      ).rowCount,
    );
  }
  async claimDelivery(
    channelId: string,
    articleId: string,
    deliveryInterface: string,
  ) {
    const result = await this.database.query(
      `INSERT INTO delivery_intents(channel_id,article_id,interface,status)
      VALUES($1,$2,$3,'sending') ON CONFLICT DO NOTHING RETURNING channel_id`,
      [channelId, articleId, deliveryInterface],
    );
    return Boolean(result.rowCount);
  }
  async markDeliveryUncertain(
    channelId: string,
    articleId: string,
    deliveryInterface: string,
  ) {
    await this.database.query(
      "UPDATE delivery_intents SET status='uncertain',updated_at=now() WHERE channel_id=$1 AND article_id=$2 AND interface=$3",
      [channelId, articleId, deliveryInterface],
    );
  }
  async recordDelivery(
    input: Parameters<ConciergeRepository["recordDelivery"]>[0],
  ) {
    return this.database.transaction(async () => {
      await this.database.query(
        `INSERT INTO deliveries(id,channel_id,article_id,interface,external_message_id,reason,delivered_at)
        VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(channel_id,article_id,interface) DO NOTHING`,
        [
          randomUUID(),
          input.channelId,
          input.articleId,
          input.interface,
          input.externalMessageId,
          input.reason,
        ],
      );
      await this.database.query(
        "UPDATE delivery_intents SET status='sent',updated_at=now() WHERE channel_id=$1 AND article_id=$2 AND interface=$3",
        [input.channelId, input.articleId, input.interface],
      );
      return deliveryFromRow(
        (
          await this.database.query(
            "SELECT * FROM deliveries WHERE channel_id=$1 AND article_id=$2 AND interface=$3",
            [input.channelId, input.articleId, input.interface],
          )
        ).rows[0],
      );
    });
  }
  async findDeliveryByMessageId(messageId: string) {
    const { rows } = await this.database.query(
      "SELECT * FROM deliveries WHERE external_message_id=$1",
      [messageId],
    );
    return rows[0] ? deliveryFromRow(rows[0]) : null;
  }
  async upsertDeliveryTarget(
    input: Parameters<ConciergeRepository["upsertDeliveryTarget"]>[0],
  ) {
    await this.ensureChannel(input.channelId, input.channelName);
    await this.database.query(
      `INSERT INTO delivery_targets(interface,channel_id,installation_id,created_at,updated_at) VALUES($1,$2,$3,now(),now())
      ON CONFLICT(interface,channel_id) DO UPDATE SET installation_id=excluded.installation_id,updated_at=excluded.updated_at`,
      [input.interface, input.channelId, input.installationId],
    );
    return deliveryTargetFromRow(
      (
        await this.database.query(
          `SELECT dt.*,c.name AS channel_name FROM delivery_targets dt JOIN channels c ON c.id=dt.channel_id
      WHERE dt.interface=$1 AND dt.channel_id=$2`,
          [input.interface, input.channelId],
        )
      ).rows[0],
    );
  }
  async removeDeliveryTarget(deliveryInterface: string, channelId: string) {
    return Boolean(
      (
        await this.database.query(
          "DELETE FROM delivery_targets WHERE interface=$1 AND channel_id=$2",
          [deliveryInterface, channelId],
        )
      ).rowCount,
    );
  }
  async listDeliveryTargets(deliveryInterface: string) {
    return (
      await this.database.query(
        `SELECT dt.*,c.name AS channel_name FROM delivery_targets dt JOIN channels c ON c.id=dt.channel_id
      WHERE dt.interface=$1 ORDER BY dt.created_at,dt.channel_id`,
        [deliveryInterface],
      )
    ).rows.map(deliveryTargetFromRow);
  }
  async startRun(source: string) {
    return runFromRow(
      (
        await this.database.query(
          "INSERT INTO ingestion_runs(id,source,status,started_at) VALUES($1,$2,'running',now()) RETURNING *",
          [randomUUID(), source],
        )
      ).rows[0],
    );
  }
  async finishRun(
    id: string,
    result: Parameters<ConciergeRepository["finishRun"]>[1],
  ) {
    await this.database.query(
      `UPDATE ingestion_runs SET status=$2,fetched_count=$3,new_count=$4,extracted_count=$5,error=$6,finished_at=now() WHERE id=$1`,
      [
        id,
        result.status,
        result.fetchedCount,
        result.newCount,
        result.extractedCount,
        result.error ?? null,
      ],
    );
  }
  async listRuns(limit: number) {
    return (
      await this.database.query(
        "SELECT * FROM ingestion_runs ORDER BY started_at DESC LIMIT $1",
        [limit],
      )
    ).rows.map(runFromRow);
  }
  async stats() {
    const { rows } = await this.database
      .query(`SELECT (SELECT count(*) FROM articles) AS articles,
      (SELECT count(*) FROM articles WHERE content_status='extracted') AS extracted,
      (SELECT count(*) FROM evaluations) AS evaluations,(SELECT count(*) FROM deliveries) AS deliveries,
      (SELECT count(*) FROM feedback) AS feedback,(SELECT count(*) FROM channels) AS channels,(SELECT count(*) FROM users) AS users`);
    const row = rows[0];
    return {
      articles: Number(row.articles),
      extracted: Number(row.extracted),
      evaluations: Number(row.evaluations),
      deliveries: Number(row.deliveries),
      feedback: Number(row.feedback),
      channels: Number(row.channels),
      users: Number(row.users),
    };
  }
}
