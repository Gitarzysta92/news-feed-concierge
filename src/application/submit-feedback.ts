import { reactionDefinition } from "../domain/reactions.js";
import type { FeedbackInterface, FeedbackReaction } from "../domain/model.js";
import type { ConciergeRepository, RankingAlgorithm } from "../domain/ports.js";
import type { ActionQueue } from "./action-queue.js";

export class SubmitFeedback {
  constructor(
    private readonly repository: ConciergeRepository,
    private readonly algorithm: RankingAlgorithm,
    private readonly actions?: ActionQueue,
  ) {}

  async execute(input: {
    channelId: string;
    channelName: string;
    articleId: string;
    actorId: string;
    reaction: FeedbackReaction;
    interface: FeedbackInterface;
  }) {
    const definition = reactionDefinition(input.reaction);
    if (!definition) throw new Error(`Unsupported reaction: ${input.reaction}`);
    const [article, profile, recent] = await Promise.all([
      this.repository.findArticle(input.articleId),
      this.repository.ensureChannel(input.channelId, input.channelName),
      this.repository.listRecentlyDeliveredArticles(input.channelId, 20),
    ]);
    if (!article) throw new Error(`Article not found: ${input.articleId}`);
    const action = this.actions?.enqueue({
      kind: "learning",
      label: `Learn from ${input.reaction} on ${article.title}`,
      detail: `Updating #${input.channelName} with ${this.algorithm.metadata.displayName}`,
      context: { articleId: article.id, channelId: input.channelId, actorId: input.actorId },
    });
    action?.start();

    try {
      const persisted = await this.repository.upsertFeedback({
        channelId: input.channelId,
        articleId: input.articleId,
        actorId: input.actorId,
        reaction: input.reaction,
        signal: definition.signal,
        interface: input.interface,
      });
      if (persisted.previous?.reaction === input.reaction) {
        action?.complete("Reaction was unchanged; profile retained");
        return { feedback: persisted.feedback, profile, changed: false };
      }

      const base = this.algorithm.score(article, profile, { now: new Date(), recentlyDelivered: recent });
      const learned = this.algorithm.learn(profile, article, base, definition.target);
      await this.repository.saveChannel(learned);
      await this.repository.invalidateEvaluations(input.channelId);
      action?.complete(`Profile advanced from v${profile.version} to v${learned.version}`);
      return { feedback: persisted.feedback, profile: learned, changed: true };
    } catch (error) {
      action?.fail(error, "Feedback learning failed");
      throw error;
    }
  }
}
