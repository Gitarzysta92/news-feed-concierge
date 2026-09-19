import { reactionDefinition } from "../domain/reactions.js";
import type { FeedbackInterface, FeedbackReaction } from "../domain/model.js";
import type { ConciergeRepository, RankingAlgorithm } from "../domain/ports.js";
import type { ActionQueue } from "./action-queue.js";
import type { RebuildChannelProfile } from "./rebuild-channel-profile.js";

export class SubmitFeedback {
  constructor(
    private readonly repository: ConciergeRepository,
    private readonly algorithm: RankingAlgorithm,
    private readonly rebuildProfile: RebuildChannelProfile,
    private readonly actions?: ActionQueue,
  ) {}

  async execute(input: {
    channelId: string;
    channelName: string;
    articleId: string;
    userId: string;
    userName?: string;
    reaction: FeedbackReaction;
    interface: FeedbackInterface;
  }) {
    const work = () => this.apply(input);
    return this.repository.withChannelLock ? this.repository.withChannelLock(input.channelId, work) : work();
  }

  private async apply(input: Parameters<SubmitFeedback["execute"]>[0]) {
    const definition = reactionDefinition(input.reaction);
    if (!definition) throw new Error(`Unsupported reaction: ${input.reaction}`);
    const [article, profile] = await Promise.all([
      this.repository.findArticle(input.articleId),
      this.repository.ensureChannel(input.channelId, input.channelName),
      this.repository.ensureUser({
        id: input.userId,
        name: input.userName,
        kind: input.interface === "discord" ? "discord" : "anonymous",
      }),
    ]);
    if (!article) throw new Error(`Article not found: ${input.articleId}`);
    const action = this.actions?.enqueue({
      kind: "learning",
      label: `Learn from ${input.reaction} on ${article.title}`,
      detail: `Updating #${input.channelName} with ${this.algorithm.metadata.displayName}`,
      context: { articleId: article.id, channelId: input.channelId, userId: input.userId },
    });
    action?.start();

    try {
      const persisted = await this.repository.upsertFeedback({
        channelId: input.channelId,
        articleId: input.articleId,
        userId: input.userId,
        reaction: input.reaction,
        signal: definition.signal,
        interface: input.interface,
      });
      if (persisted.previous?.reaction === input.reaction) {
        action?.complete("Reaction was unchanged; profile retained");
        return { feedback: persisted.feedback, profile, changed: false };
      }

      const rebuilt = await this.rebuildProfile.execute(input.channelId, input.channelName);
      action?.complete(`Profile rebuilt from ${rebuilt.signalCount} current signals · v${profile.version} → v${rebuilt.profile.version}`);
      return { feedback: persisted.feedback, profile: rebuilt.profile, changed: true };
    } catch (error) {
      action?.fail(error, "Feedback learning failed");
      throw error;
    }
  }
}
