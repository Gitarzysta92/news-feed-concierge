import { createDefaultProfile } from "../domain/channel-profile.js";
import type { Article, ChannelProfile } from "../domain/model.js";
import type { ConciergeRepository, RankingAlgorithm } from "../domain/ports.js";
import { reactionDefinition } from "../domain/reactions.js";
import { inferArticleTags } from "../domain/tag-inference.js";

export interface RebuildChannelProfileResult {
  profile: ChannelProfile;
  changed: boolean;
  signalCount: number;
}

export class RebuildChannelProfile {
  constructor(
    private readonly repository: ConciergeRepository,
    private readonly algorithm: RankingAlgorithm,
  ) {}

  async execute(channelId: string, channelName: string): Promise<RebuildChannelProfileResult> {
    const [existing, feedback, recentlyDelivered] = await Promise.all([
      this.repository.ensureChannel(channelId, channelName),
      this.repository.listChannelFeedback(channelId),
      this.repository.listRecentlyDeliveredArticles(channelId, 20),
    ]);
    let rebuilt = createDefaultProfile(channelId, channelName);
    let articleTagsChanged = false;
    for (const signal of feedback) {
      const storedArticle = await this.repository.findArticle(signal.articleId);
      const definition = reactionDefinition(signal.reaction);
      if (!storedArticle || !definition) continue;
      const enriched = await this.ensureArticleTags(storedArticle);
      articleTagsChanged ||= enriched.changed;
      const score = this.algorithm.score(enriched.article, rebuilt, {
        now: new Date(signal.updatedAt),
        recentlyDelivered,
      });
      rebuilt = this.algorithm.learn(rebuilt, enriched.article, score, definition.target);
    }

    const parametersChanged = !sameParameters(existing, rebuilt);
    const changed = parametersChanged || articleTagsChanged;
    if (!changed) return { profile: existing, changed: false, signalCount: feedback.length };

    const corrected: ChannelProfile = {
      ...rebuilt,
      id: existing.id,
      name: channelName,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.saveChannel(corrected);
    await this.repository.invalidateEvaluations(channelId);
    return { profile: corrected, changed: true, signalCount: feedback.length };
  }

  private async ensureArticleTags(article: Article): Promise<{ article: Article; changed: boolean }> {
    const tags = inferArticleTags(
      article.title,
      `${article.summary} ${article.content.slice(0, 4_000)}`,
      article.tags,
    );
    if (sameTags(tags, article.tags)) return { article, changed: false };
    const { id, fetchedAt, ...incoming } = article;
    void id;
    void fetchedAt;
    const persisted = await this.repository.upsertArticle({ ...incoming, tags });
    return { article: persisted.article, changed: true };
  }
}

function sameParameters(left: ChannelProfile, right: ChannelProfile): boolean {
  return JSON.stringify(left.weights) === JSON.stringify(right.weights)
    && JSON.stringify(left.tagAffinities) === JSON.stringify(right.tagAffinities);
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag === right[index]);
}
