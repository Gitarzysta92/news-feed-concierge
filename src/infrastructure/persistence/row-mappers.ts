import type {
  Article,
  ChannelProfile,
  StoredEvaluation,
  RankingScore,
  LlmAssessment,
  Feedback,
  User,
  Delivery,
  DeliveryTarget,
  IngestionRun,
} from "../../domain/model.js";
type Row = Record<string, unknown>;

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function isoDate(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export function articleFromRow(row: Row): Article {
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
    tags: jsonValue(row.tags_json) as string[],
    imageUrl: row.image_url ? String(row.image_url) : null,
    popularity: Number(row.popularity),
    publishedAt: isoDate(row.published_at),
    fetchedAt: isoDate(row.fetched_at),
  };
}

export function channelFromRow(row: Row): ChannelProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    weights: jsonValue(row.weights_json) as ChannelProfile["weights"],
    tagAffinities: jsonValue(row.tag_affinities_json) as Record<string, number>,
    version: Number(row.version),
    updatedAt: isoDate(row.updated_at),
  };
}

export function evaluationFromRow(row: Row): StoredEvaluation {
  return {
    articleId: String(row.article_id),
    channelId: String(row.channel_id),
    profileVersion: Number(row.profile_version),
    cacheKey: row.cache_key ? String(row.cache_key) : undefined,
    rankingAlgorithm: String(row.ranking_algorithm),
    base: jsonValue(row.classic_json) as RankingScore,
    llm: row.llm_json ? (jsonValue(row.llm_json) as LlmAssessment) : null,
    finalScore: Number(row.final_score),
    reason: String(row.reason),
    evaluatedAt: isoDate(row.evaluated_at),
  };
}

export function feedbackFromRow(row: Row): Feedback {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    articleId: String(row.article_id),
    userId: String(row.actor_id),
    reaction: row.reaction as Feedback["reaction"],
    signal: Number(row.signal),
    interface: row.interface as Feedback["interface"],
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

export function userFromRow(row: Row): User {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as User["kind"],
    createdAt: isoDate(row.created_at),
    lastSeenAt: isoDate(row.last_seen_at),
  };
}

export function defaultUserName(id: string, kind: User["kind"]): string {
  const shortId = id.slice(0, 8).toUpperCase();
  if (kind === "discord") return `Discord ${shortId}`;
  if (kind === "system") return "System";
  if (kind === "legacy") return `Legacy ${shortId}`;
  return `Visitor ${shortId}`;
}

export function deliveryFromRow(row: Row): Delivery {
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    articleId: String(row.article_id),
    interface: String(row.interface),
    externalMessageId: row.external_message_id
      ? String(row.external_message_id)
      : null,
    reason: row.reason as Delivery["reason"],
    deliveredAt: isoDate(row.delivered_at),
  };
}

export function deliveryTargetFromRow(row: Row): DeliveryTarget {
  return {
    interface: String(row.interface),
    channelId: String(row.channel_id),
    channelName: String(row.channel_name),
    installationId: row.installation_id ? String(row.installation_id) : null,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
  };
}

export function runFromRow(row: Row): IngestionRun {
  return {
    id: String(row.id),
    source: String(row.source),
    status: row.status as IngestionRun["status"],
    fetchedCount: Number(row.fetched_count),
    newCount: Number(row.new_count),
    extractedCount: Number(row.extracted_count),
    error: row.error ? String(row.error) : null,
    startedAt: isoDate(row.started_at),
    finishedAt: row.finished_at ? isoDate(row.finished_at) : null,
  };
}
