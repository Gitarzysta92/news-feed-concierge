import { createContainer } from "../bootstrap/container.js";
import { startApi, type ApiListenOptions } from "./api.js";
import { DiscordBotAdapter } from "../infrastructure/discord/discord-bot-adapter.js";
import { ConciergeScheduler } from "../infrastructure/scheduler/concierge-scheduler.js";

export async function startApplication(apiOptions: ApiListenOptions = {}) {
  const container = await createContainer();
  const server = await startApi(container, apiOptions);
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

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    if (discord) await discord.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  };

  return { container, server, shutdown };
}

async function main() {
  const application = await startApplication();
  const shutdown = () => {
    void application.shutdown().catch((error) => {
      console.error("Application shutdown failed", error);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
