import type { DeliveryReason } from "../domain/model.js";
import type { ConciergeRepository, DeliveryEdge } from "../domain/ports.js";
import { RankFeed } from "./rank-feed.js";
import type { ActionQueue } from "./action-queue.js";

export class DeliverFeed {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly repository: ConciergeRepository,
    private readonly rankFeed: RankFeed,
    private readonly actions?: ActionQueue,
    private readonly scheduleEvaluation?: (channelId: string, channelName: string) => Promise<unknown> | unknown,
  ) {}

  async execute(input: {
    channelId: string;
    channelName: string;
    edge: DeliveryEdge;
    reason: DeliveryReason;
    count?: number;
    minimumScore?: number;
  }) {
    const ranked = await this.rankFeed.execute(input.channelId, input.channelName, {
      limit: Math.max(input.count ?? 1, 5),
      onlyUndelivered: true,
      deliveryInterface: input.edge.key,
      semanticMode: "cached-only",
    });
    await this.scheduleEvaluation?.(input.channelId, input.channelName);
    const delivered = [];
    for (const item of ranked) {
      if (delivered.length >= (input.count ?? 1)) break;
      if (item.finalScore < (input.minimumScore ?? 0)) continue;
      const key = `${input.channelId}:${item.article.id}`;
      if (
        this.inFlight.has(key)
        || await this.repository.hasDelivery(input.channelId, item.article.id, input.edge.key)
      ) continue;
      if (this.repository.claimDelivery && !await this.repository.claimDelivery(input.channelId, item.article.id, input.edge.key)) continue;
      this.inFlight.add(key);
      const action = this.actions?.enqueue({
        kind: "delivery",
        label: `Deliver ${item.article.title}`,
        detail: `Publishing to #${input.channelName} through ${input.edge.key}`,
        context: { articleId: item.article.id, channelId: input.channelId, edge: input.edge.key },
      });
      action?.start();
      try {
        const messageId = await input.edge.publish(input.channelId, item, input.reason);
        await this.repository.recordDelivery({
          channelId: input.channelId,
          articleId: item.article.id,
          interface: input.edge.key,
          externalMessageId: messageId,
          reason: input.reason,
        });
        delivered.push(item);
        action?.complete(`Delivered through ${input.edge.key} · ${input.reason}`);
      } catch (error) {
        await this.repository.markDeliveryUncertain?.(input.channelId, item.article.id, input.edge.key);
        action?.fail(error, `Delivery through ${input.edge.key} failed`);
        throw error;
      } finally {
        this.inFlight.delete(key);
      }
    }
    return delivered;
  }
}
