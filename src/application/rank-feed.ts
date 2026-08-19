import type {
  Article,
  ChannelProfile,
  FeedbackInterface,
  LlmAssessment,
  ProcessingStage,
  RankedArticle,
  RankingAlgorithmReference,
  RankingScore,
  StoredEvaluation,
} from "../domain/model.js";
import type { ConciergeRepository, LlmEvaluator, RankingAlgorithm } from "../domain/ports.js";
import type { ActionQueue } from "./action-queue.js";

export interface RankFeedOptions {
  limit?: number;
  onlyUndelivered?: boolean;
  deliveryInterface?: string;
  semanticMode?: "blocking" | "cached-only";
}

export interface LatestArticlePageOptions {
  page: number;
  pageSize: number;
  semanticMode?: "blocking" | "cached-only";
  unratedBy?: {
    userId: string;
    interface: FeedbackInterface;
  };
}

export interface LatestArticlePage {
  items: RankedArticle[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export class RankFeed {
  constructor(
    private readonly repository: ConciergeRepository,
    private readonly algorithm: RankingAlgorithm,
    private readonly llm: LlmEvaluator,
    private readonly llmWeight = 0.3,
    private readonly candidateLimit = 120,
    private readonly llmCandidateLimit = 8,
    private readonly actions?: ActionQueue,
  ) {}

  async execute(channelId: string, channelName: string, options: RankFeedOptions = {}): Promise<RankedArticle[]> {
    const limit = options.limit ?? 10;
    const cachedSemanticOnly = options.semanticMode === "cached-only";
    const profile = await this.repository.ensureChannel(channelId, channelName);
    const [articles, recentlyDelivered] = await Promise.all([
      this.repository.listArticles(this.candidateLimit),
      this.repository.listRecentlyDeliveredArticles(channelId, 20),
    ]);
    if (options.onlyUndelivered && !options.deliveryInterface) {
      throw new Error("deliveryInterface is required when filtering delivered articles");
    }
    const candidates = options.onlyUndelivered
      ? (await Promise.all(articles.map(async (article) => ({
          article,
          delivered: await this.repository.hasDelivery(channelId, article.id, options.deliveryInterface!),
        })))).filter((item) => !item.delivered).map((item) => item.article)
      : articles;

    const ranked = await this.evaluateCandidates(
      channelId,
      channelName,
      profile,
      candidates,
      recentlyDelivered,
      cachedSemanticOnly,
    );

    return ranked.sort((left, right) => right.finalScore - left.finalScore).slice(0, limit);
  }

  async executeLatestPage(
    channelId: string,
    channelName: string,
    options: LatestArticlePageOptions,
  ): Promise<LatestArticlePage> {
    const page = Math.max(1, options.page);
    const pageSize = Math.max(1, options.pageSize);
    const profile = await this.repository.ensureChannel(channelId, channelName);
    const [articlePage, recentlyDelivered] = await Promise.all([
      this.repository.listArticlePage({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        unratedBy: options.unratedBy
          ? { channelId, userId: options.unratedBy.userId, interface: options.unratedBy.interface }
          : undefined,
      }),
      this.repository.listRecentlyDeliveredArticles(channelId, 20),
    ]);
    const evaluated = await this.evaluateCandidates(
      channelId,
      channelName,
      profile,
      articlePage.articles,
      recentlyDelivered,
      options.semanticMode === "cached-only",
    );
    const byArticleId = new Map(evaluated.map((item) => [item.article.id, item]));

    return {
      items: articlePage.articles.flatMap((article) => {
        const item = byArticleId.get(article.id);
        return item ? [item] : [];
      }),
      page,
      pageSize,
      total: articlePage.total,
      totalPages: Math.max(1, Math.ceil(articlePage.total / pageSize)),
    };
  }

  private async evaluateCandidates(
    channelId: string,
    channelName: string,
    profile: ChannelProfile,
    candidates: Article[],
    recentlyDelivered: Article[],
    cachedSemanticOnly: boolean,
  ): Promise<RankedArticle[]> {

    const context = { now: new Date(), recentlyDelivered };
    const algorithm = algorithmReference(this.algorithm);
    const baseRanked = candidates
      .map((article) => ({ article, base: this.algorithm.score(article, profile, context) }))
      .sort((left, right) => right.base.score - left.base.score);
    const llmCandidateIds = new Set(
      baseRanked
        .filter(({ article }) => article.contentStatus === "extracted")
        .slice(0, this.llmCandidateLimit)
        .map(({ article }) => article.id),
    );

    const ranked = await Promise.all(baseRanked.map(async ({ article, base }): Promise<RankedArticle> => {
      const cached = await this.repository.findEvaluation(article.id, channelId, profile.version);
      const shouldUseLlm = this.llm.enabled
        && llmCandidateIds.has(article.id);
      const cacheMatchesEvaluator = shouldUseLlm
        ? cachedSemanticOnly
          ? cached?.llm === null || cached?.llm?.model === this.llm.name
          : cached?.llm?.model === this.llm.name
        : cached?.llm === null;
      const cacheMatchesAlgorithm = cached?.rankingAlgorithm === this.algorithm.name;
      if (cached && cacheMatchesAlgorithm && cacheMatchesEvaluator) {
        return fromStored(
          article,
          cached,
          algorithm,
          semanticOutcome(
            article,
            this.llm.enabled,
            shouldUseLlm,
            cached.llm,
            this.llmCandidateLimit,
            cachedSemanticOnly,
          ),
        );
      }

      let llm = null;
      let semantic = semanticOutcome(
        article,
        this.llm.enabled,
        shouldUseLlm,
        null,
        this.llmCandidateLimit,
        cachedSemanticOnly,
      );
      if (shouldUseLlm && !cachedSemanticOnly) {
        const action = this.actions?.enqueue({
          kind: "semantic-evaluation",
          label: article.title,
          detail: `Waiting for ${this.llm.name} evaluation for #${channelName}`,
          context: { articleId: article.id, channelId, evaluator: this.llm.name },
        });
        action?.start(`Evaluating full article with ${this.llm.name}`);
        try {
          llm = await this.llm.assess({
            article,
            profile,
            rankingAlgorithm: this.algorithm.name,
            base,
          });
          semantic = llm
            ? { status: "completed", detail: `${llm.model} scored ${formatScore(llm.score)}` }
            : { status: "failed", detail: "Evaluator returned no assessment; base score used" };
          if (llm) action?.complete(`${llm.model} scored ${formatScore(llm.score)}`);
          else action?.fail(new Error("Evaluator returned no assessment"), "Base ranking retained");
        } catch (error) {
          console.warn("LLM evaluation failed; using base ranking score", error);
          action?.fail(error, "Semantic evaluation failed; base ranking retained");
          semantic = { status: "failed", detail: "Semantic evaluation failed; base score used" };
        }
      }
      const finalScore = llm
        ? base.score * (1 - this.llmWeight) + llm.score * this.llmWeight
        : base.score;
      const reason = llm?.reason ?? baseReason(base, this.algorithm.name);
      await this.repository.saveEvaluation({
        articleId: article.id,
        channelId,
        profileVersion: profile.version,
        rankingAlgorithm: this.algorithm.name,
        base,
        llm,
        finalScore,
        reason,
        evaluatedAt: new Date().toISOString(),
      });
      return {
        article,
        rankingAlgorithm: this.algorithm.name,
        algorithm,
        base,
        llm,
        finalScore,
        reason,
        processing: processingTrace(article, this.algorithm.name, base, llm, finalScore, semantic),
      };
    }));

    return ranked;
  }
}

function fromStored(
  article: RankedArticle["article"],
  stored: StoredEvaluation,
  algorithm: RankingAlgorithmReference,
  semantic: SemanticOutcome,
): RankedArticle {
  return {
    article,
    rankingAlgorithm: stored.rankingAlgorithm,
    algorithm,
    base: stored.base,
    llm: stored.llm,
    finalScore: stored.finalScore,
    reason: stored.reason,
    processing: processingTrace(
      article,
      stored.rankingAlgorithm,
      stored.base,
      stored.llm,
      stored.finalScore,
      semantic,
    ),
  };
}

function algorithmReference(algorithm: RankingAlgorithm): RankingAlgorithmReference {
  const { displayName, version, summary } = algorithm.metadata;
  return { id: algorithm.name, displayName, version, summary };
}

interface SemanticOutcome {
  status: ProcessingStage["status"];
  detail: string;
}

function semanticOutcome(
  article: Article,
  evaluatorEnabled: boolean,
  selected: boolean,
  llm: LlmAssessment | null,
  candidateLimit: number,
  cachedOnly = false,
): SemanticOutcome {
  if (llm) return { status: "completed", detail: `${llm.model} scored ${formatScore(llm.score)}` };
  if (!evaluatorEnabled) return { status: "skipped", detail: "Semantic evaluator is disabled" };
  if (article.contentStatus !== "extracted") {
    return { status: "skipped", detail: "Requires successfully extracted full text" };
  }
  if (!selected) {
    return {
      status: "skipped",
      detail: `Outside the top ${candidateLimit} full-text candidates for this request`,
    };
  }
  if (cachedOnly) {
    return { status: "skipped", detail: "No cached semantic result; dashboard returned the base rank without waiting" };
  }
  return { status: "failed", detail: "Semantic evaluation produced no reusable result" };
}

function processingTrace(
  article: Article,
  algorithm: string,
  base: RankingScore,
  llm: LlmAssessment | null,
  finalScore: number,
  semantic: SemanticOutcome,
): ProcessingStage[] {
  const extraction: ProcessingStage = article.contentStatus === "extracted"
    ? {
        key: "full-text",
        label: "Full text",
        status: "completed",
        detail: `${article.content.length.toLocaleString()} characters extracted`,
      }
    : article.contentStatus === "source-only"
      ? {
          key: "full-text",
          label: "Full text",
          status: "skipped",
          detail: "Only source-provided text is available",
        }
      : {
          key: "full-text",
          label: "Full text",
          status: "failed",
          detail: "Full-text extraction failed",
        };
  return [
    {
      key: "collected",
      label: "Collected",
      status: "completed",
      detail: `Fetched from ${article.sourceLabel}`,
    },
    extraction,
    {
      key: "base-ranking",
      label: "Base rank",
      status: "completed",
      detail: `${algorithm} scored ${formatScore(base.score)}`,
    },
    {
      key: "semantic-evaluation",
      label: "Semantic",
      ...semantic,
    },
    {
      key: "finalized",
      label: "Final",
      status: "completed",
      detail: `${llm ? "Hybrid" : "Base-only"} score ${formatScore(finalScore)}`,
    },
  ];
}

function formatScore(score: number): string {
  return score.toFixed(2);
}

function baseReason(base: RankedArticle["base"], algorithm: string): string {
  const strongest = Object.entries(base.contributions)
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2)
    .map(([feature]) => feature.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`));
  return `${algorithm} ranked this for ${strongest.join(" and ")}; semantic evaluation was not applied.`;
}
