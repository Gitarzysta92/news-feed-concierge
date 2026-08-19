import { createContainer } from "../bootstrap/container.js";
import { startApi } from "./api.js";
import { DiscordBotAdapter } from "../infrastructure/discord/discord-bot-adapter.js";
import { ConciergeScheduler } from "../infrastructure/scheduler/concierge-scheduler.js";

async function main() {
  const container = await createContainer();
  const server = await startApi(container);
  const discord = container.config.discord.enabled ? new DiscordBotAdapter({
    config: container.config.discord,
    deliverFeed: container.deliverFeed,
    submitFeedback: container.submitFeedback,
    repository: container.repository,
    llm: container.llm,
  }) : null;
  if (discord) await discord.start();
  const scheduler = new ConciergeScheduler({
    config: {
      ingestCron: container.config.ingestCron,
      deliveryCron: container.config.deliveryCron,
      deliveryCount: container.config.deliveryCount,
      serendipityThreshold: container.config.serendipityThreshold,
      serendipityProbability: container.config.serendipityProbability,
      runIngestionOnStart: container.config.runIngestionOnStart,
      channels: container.config.discord.channels,
    },
    ingestionCoordinator: container.ingestionCoordinator,
    rankFeed: container.rankFeed,
    deliverFeed: container.deliverFeed,
  }, discord);
  scheduler.start();

  const shutdown = async () => {
    scheduler.stop();
    if (discord) await discord.stop();
    server.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
