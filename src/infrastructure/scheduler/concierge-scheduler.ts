import cron, { type ScheduledTask } from "node-cron";
import type { DeliverFeed } from "../../application/deliver-feed.js";
import type { IngestionCoordinator } from "../../application/ingestion-coordinator.js";
import type { RankFeed } from "../../application/rank-feed.js";
import type { ConciergeRepository, DeliveryEdge } from "../../domain/ports.js";

export interface SchedulerDependencies {
  config: {
    ingestCron: string;
    deliveryCron: string;
    deliveryCount: number;
    serendipityThreshold: number;
    serendipityProbability: number;
    runIngestionOnStart: boolean;
  };
  repository: Pick<ConciergeRepository, "listDeliveryTargets">;
  ingestionCoordinator: Pick<IngestionCoordinator, "execute">;
  rankFeed: Pick<RankFeed, "execute">;
  deliverFeed: Pick<DeliverFeed, "execute">;
}

export class ConciergeScheduler {
  private readonly tasks: ScheduledTask[] = [];
  private deliveryRunning = false;

  constructor(
    private readonly dependencies: SchedulerDependencies,
    private readonly edge: DeliveryEdge | null,
  ) {}

  start(): void {
    this.tasks.push(cron.schedule(this.dependencies.config.ingestCron, () => void this.ingestAndConsiderSerendipity(), {
      name: "content-ingestion",
      noOverlap: true,
    }));
    this.tasks.push(cron.schedule(this.dependencies.config.deliveryCron, () => void this.deliverScheduled(), {
      name: "scheduled-delivery",
      noOverlap: true,
    }));
    if (this.dependencies.config.runIngestionOnStart) void this.ingestAndConsiderSerendipity();
  }

  stop(): void {
    for (const task of this.tasks) task.stop();
  }

  private async ingestAndConsiderSerendipity(): Promise<void> {
    try {
      await this.dependencies.ingestionCoordinator.execute();
      if (!this.edge) return;
      const targets = await this.dependencies.repository.listDeliveryTargets(this.edge.key);
      for (const target of targets) {
        const [top] = await this.dependencies.rankFeed.execute(target.channelId, target.channelName, {
          limit: 1,
          onlyUndelivered: true,
          deliveryInterface: this.edge.key,
        });
        const isExceptional = top && top.finalScore >= this.dependencies.config.serendipityThreshold;
        if (isExceptional && Math.random() <= this.dependencies.config.serendipityProbability) {
          await this.dependencies.deliverFeed.execute({
            channelId: target.channelId,
            channelName: target.channelName,
            edge: this.edge,
            reason: "serendipity",
            count: 1,
            minimumScore: this.dependencies.config.serendipityThreshold,
          });
        }
      }
    } catch (error) {
      console.error("Scheduled ingestion failed", error);
    }
  }

  private async deliverScheduled(): Promise<void> {
    if (!this.edge || this.deliveryRunning) return;
    this.deliveryRunning = true;
    try {
      const targets = await this.dependencies.repository.listDeliveryTargets(this.edge.key);
      for (const target of targets) {
        await this.dependencies.deliverFeed.execute({
          channelId: target.channelId,
          channelName: target.channelName,
          edge: this.edge,
          reason: "scheduled",
          count: this.dependencies.config.deliveryCount,
        });
      }
    } catch (error) {
      console.error("Scheduled delivery failed", error);
    } finally {
      this.deliveryRunning = false;
    }
  }
}
