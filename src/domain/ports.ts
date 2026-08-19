import type {
  Article,
  ChannelProfile,
  DashboardStats,
  Delivery,
  DeliveryReason,
  Feedback,
  FeedbackInterface,
  FeedbackReaction,
  IngestionRun,
  IncomingArticle,
  LlmAssessment,
  RankedArticle,
  RankingAlgorithmLiveState,
  RankingAlgorithmMetadata,
  RankingScore,
  SourceArticle,
  StoredEvaluation,
  User,
  UserKind,
} from "./model.js";

export interface RankingContext {
  now: Date;
  recentlyDelivered: Article[];
}

export interface RankingAlgorithm {
  readonly name: string;
  readonly metadata: RankingAlgorithmMetadata;
  inspect(profile: ChannelProfile): RankingAlgorithmLiveState;
  score(article: Article, profile: ChannelProfile, context: RankingContext): RankingScore;
  learn(profile: ChannelProfile, article: Article, score: RankingScore, target: number): ChannelProfile;
}

export interface LlmEvaluator {
  readonly enabled: boolean;
  readonly name: string;
  assess(input: {
    article: Article;
    profile: ChannelProfile;
    rankingAlgorithm: string;
    base: RankingScore;
  }): Promise<LlmAssessment | null>;
}

export interface ContentSource {
  readonly key: string;
  readonly label: string;
  readonly quality: number;
  fetchLatest(limit: number): Promise<SourceArticle[]>;
}

export interface ExtractedContent {
  text: string;
  description: string | null;
  imageUrl: string | null;
}

export interface ContentExtractor {
  extract(url: string): Promise<ExtractedContent>;
}

export interface ConciergeRepository {
  initialize(): Promise<void>;
  upsertArticle(article: IncomingArticle): Promise<{ article: Article; inserted: boolean }>;
  updateSourceMetadata(source: string, label: string, quality: number): Promise<void>;
  findArticle(id: string): Promise<Article | null>;
  listArticles(limit: number): Promise<Article[]>;
  listRecentlyDeliveredArticles(channelId: string, limit: number): Promise<Article[]>;

  ensureChannel(id: string, name: string): Promise<ChannelProfile>;
  findChannel(id: string): Promise<ChannelProfile | null>;
  listChannels(): Promise<ChannelProfile[]>;
  saveChannel(profile: ChannelProfile): Promise<void>;

  ensureUser(input: { id?: string; name?: string; kind: UserKind }): Promise<User>;
  listUsers(limit: number): Promise<User[]>;
  updateUserName(id: string, name: string): Promise<User>;
  listUserFeedback(channelId: string, userId: string, feedbackInterface?: FeedbackInterface): Promise<Feedback[]>;
  listChannelFeedback(channelId: string): Promise<Feedback[]>;

  findEvaluation(articleId: string, channelId: string, profileVersion: number): Promise<StoredEvaluation | null>;
  saveEvaluation(evaluation: StoredEvaluation): Promise<void>;
  invalidateEvaluations(channelId: string): Promise<void>;

  upsertFeedback(input: {
    channelId: string;
    articleId: string;
    userId: string;
    reaction: FeedbackReaction;
    signal: number;
    interface: FeedbackInterface;
  }): Promise<{ feedback: Feedback; previous: Feedback | null }>;

  hasDelivery(channelId: string, articleId: string, deliveryInterface: string): Promise<boolean>;
  recordDelivery(input: {
    channelId: string;
    articleId: string;
    interface: string;
    externalMessageId: string | null;
    reason: DeliveryReason;
  }): Promise<Delivery>;
  findDeliveryByMessageId(messageId: string): Promise<Delivery | null>;

  startRun(source: string): Promise<IngestionRun>;
  finishRun(id: string, result: {
    status: "completed" | "failed";
    fetchedCount: number;
    newCount: number;
    extractedCount: number;
    error?: string;
  }): Promise<void>;
  listRuns(limit: number): Promise<IngestionRun[]>;
  stats(): Promise<DashboardStats>;
}

export interface DeliveryEdge {
  readonly key: string;
  publish(channelId: string, item: RankedArticle, reason: DeliveryReason): Promise<string>;
}
