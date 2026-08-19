export const RANKING_FEATURES = [
  "topicAffinity",
  "freshness",
  "novelty",
  "sourceQuality",
  "popularity",
] as const;

export type RankingFeature = (typeof RANKING_FEATURES)[number];
export type FeatureVector = Record<RankingFeature, number>;
export type FeatureWeights = Record<RankingFeature, number>;
export type ArticleSource = string;
export type ContentStatus = "extracted" | "source-only" | "failed";
export type FeedbackReaction = "👍" | "🔥" | "👎" | "💤";
export type FeedbackInterface = string;
export type DeliveryReason = "command" | "scheduled" | "serendipity";
export type UserKind = "anonymous" | "discord" | "system" | "legacy";

export interface User {
  id: string;
  name: string;
  kind: UserKind;
  createdAt: string;
  lastSeenAt: string;
}

export interface Article {
  id: string;
  source: ArticleSource;
  sourceLabel: string;
  sourceQuality: number;
  externalId: string;
  url: string;
  title: string;
  summary: string;
  content: string;
  contentStatus: ContentStatus;
  author: string | null;
  tags: string[];
  imageUrl: string | null;
  popularity: number;
  publishedAt: string;
  fetchedAt: string;
}

export type IncomingArticle = Omit<Article, "id" | "fetchedAt">;

export interface ChannelProfile {
  id: string;
  name: string;
  weights: FeatureWeights;
  tagAffinities: Record<string, number>;
  version: number;
  updatedAt: string;
}

export interface RankingScore {
  score: number;
  features: Record<string, number>;
  contributions: Record<string, number>;
}

export interface RankingAlgorithmFeatureMetadata {
  key: string;
  label: string;
  description: string;
}

export interface RankingAlgorithmMetadata {
  displayName: string;
  version: string;
  summary: string;
  description: string;
  learningStrategy: string;
  capabilities: string[];
  scoreRange: { min: number; max: number };
  features: RankingAlgorithmFeatureMetadata[];
}

export interface RankingAlgorithmDescriptor extends RankingAlgorithmMetadata {
  id: string;
}

export interface RankingAlgorithmParameter {
  key: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
}

export interface RankingAlgorithmParameterGroup {
  key: string;
  label: string;
  description: string;
  parameters: RankingAlgorithmParameter[];
}

export interface RankingAlgorithmLiveState {
  revision: number;
  updatedAt: string;
  groups: RankingAlgorithmParameterGroup[];
}

export type RankingAlgorithmReference = Pick<
  RankingAlgorithmDescriptor,
  "id" | "displayName" | "version" | "summary"
>;

export interface LlmAssessment {
  score: number;
  relevance: number;
  novelty: number;
  quality: number;
  topics: string[];
  reason: string;
  model: string;
}

export type ProcessingStatus = "completed" | "skipped" | "failed";

export interface ProcessingStage {
  key: "collected" | "full-text" | "base-ranking" | "semantic-evaluation" | "finalized";
  label: string;
  status: ProcessingStatus;
  detail: string;
}

export interface RankedArticle {
  article: Article;
  rankingAlgorithm: string;
  algorithm: RankingAlgorithmReference;
  base: RankingScore;
  llm: LlmAssessment | null;
  finalScore: number;
  reason: string;
  processing: ProcessingStage[];
}

export interface Feedback {
  id: string;
  channelId: string;
  articleId: string;
  userId: string;
  reaction: FeedbackReaction;
  signal: number;
  interface: FeedbackInterface;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: string;
  channelId: string;
  articleId: string;
  interface: string;
  externalMessageId: string | null;
  reason: DeliveryReason;
  deliveredAt: string;
}

export interface DeliveryTarget {
  interface: string;
  channelId: string;
  channelName: string;
  installationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IngestionRun {
  id: string;
  source: string;
  status: "running" | "completed" | "failed";
  fetchedCount: number;
  newCount: number;
  extractedCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface StoredEvaluation {
  articleId: string;
  channelId: string;
  profileVersion: number;
  rankingAlgorithm: string;
  base: RankingScore;
  llm: LlmAssessment | null;
  finalScore: number;
  reason: string;
  evaluatedAt: string;
}

export interface DashboardStats {
  articles: number;
  extracted: number;
  evaluations: number;
  deliveries: number;
  feedback: number;
  channels: number;
  users: number;
}

export interface SourceArticle {
  externalId: string;
  url: string;
  title: string;
  summary: string;
  sourceContent: string;
  author: string | null;
  tags: string[];
  imageUrl: string | null;
  popularity: number;
  publishedAt: string;
}
