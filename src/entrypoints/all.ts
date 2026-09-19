import { createContainer } from "../bootstrap/container.js";
import { startApi, type ApiListenOptions } from "./api.js";
import { DiscordBotAdapter } from "../infrastructure/discord/discord-bot-adapter.js";
import { ConciergeScheduler } from "../infrastructure/scheduler/concierge-scheduler.js";

export async function startApplication(apiOptions: ApiListenOptions = {}) {
  const container = await createContainer({ exclusive: true });
  let server: Awaited<ReturnType<typeof startApi>>;
  try {
    await container.workflowStore?.recoverActivity();
    server = await startApi(container, apiOptions);
  } catch (error) {
    await container.close();
    throw error;
  }
  const discord = container.config.discord.enabled
    ? new DiscordBotAdapter({
        config: container.config.discord,
        deliverFeed: container.deliverFeed,
        submitFeedback: container.submitFeedback,
        repository: container.repository,
        llm: container.llm,
      })
    : null;
  try {
    if (discord) await discord.start();
  } catch (error) {
    await discord?.stop();
    server.close();
    await container.close();
    throw error;
  }
  const scheduler = new ConciergeScheduler(
    {
      workflows: container.workflows,
      config: {
        ingestCron: container.config.ingestCron,
        deliveryCron: container.config.deliveryCron,
        deliveryCount: container.config.deliveryCount,
        serendipityThreshold: container.config.serendipityThreshold,
        serendipityProbability: container.config.serendipityProbability,
        runIngestionOnStart: container.config.runIngestionOnStart,
      },
      repository: container.repository,
      ingestionCoordinator: container.ingestionCoordinator,
      rankFeed: container.rankFeed,
      deliverFeed: container.deliverFeed,
    },
    discord,
  );
  scheduler.start();
  container.workflows?.start();

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    scheduler.stop();
    await container.workflows?.stop();
    await container.actionQueue.flush();
    if (discord) await discord.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await container.close();
  };

  return { container, server, shutdown };
}

async function main() {
  const application = await startApplication();
  const shutdown = () => {
    const deadline = setTimeout(() => process.exit(1), 30_000);
    deadline.unref();
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
