import { Workflows } from "../application/workflows.js";
import { LiveInference } from "./live-inference.js";
import { PostgresWorkflowStore } from "../infrastructure/postgres/workflow-store.js";
import { PostgresDatabase } from "../infrastructure/postgres/database.js";
import { PostgresConciergeRepository } from "../infrastructure/postgres/postgres-repository.js";
import { IngestArticles } from "../application/ingest-articles.js";
import { IngestionCoordinator } from "../application/ingestion-coordinator.js";
import { RankFeed } from "../application/rank-feed.js";
import { SubmitFeedback } from "../application/submit-feedback.js";
import { DeliverFeed } from "../application/deliver-feed.js";
import { ActionQueue } from "../application/action-queue.js";
import { RebuildChannelProfile } from "../application/rebuild-channel-profile.js";
import type { LlmEvaluator, ConciergeRepository } from "../domain/ports.js";
import { config } from "../config.js";
import { HtmlContentExtractor } from "../infrastructure/sources/html-content-extractor.js";
import { SqliteConciergeRepository } from "../infrastructure/sqlite/sqlite-repository.js";
import { createDefaultContentSourceRegistry } from "./content-source-registry.js";
import { createDefaultRankingAlgorithmRegistry } from "./ranking-algorithm-registry.js";

export async function createContainer(options: { exclusive?: boolean } = {}) {
  const sources = createDefaultContentSourceRegistry().all();
  const database = config.databaseUrl
    ? new PostgresDatabase(config.databaseUrl)
    : null;
  const repository: ConciergeRepository = database
    ? new PostgresConciergeRepository(database)
    : new SqliteConciergeRepository(config.databaseFile);
  let releaseOwner: (() => Promise<void>) | undefined;
  try {
    await repository.initialize();
    if (options.exclusive && database) {
      const owner = await database.pool.connect();
      try {
        const lock = await owner.query(
          "SELECT pg_try_advisory_lock(73190402) AS owned",
        );
        if (!lock.rows[0].owned)
          throw new Error(
            "Another server already owns the scheduler and Discord connection",
          );
      } catch (error) {
        owner.release();
        throw error;
      }
      owner.on("error", () => {
        console.error("Server ownership connection lost");
        process.exit(1);
      });
      releaseOwner = async () => {
        await owner.query("SELECT pg_advisory_unlock(73190402)");
        owner.release();
      };
    }
    await Promise.all(
      sources.map((source) =>
        repository.updateSourceMetadata(
          source.key,
          source.label,
          source.quality,
        ),
      ),
    );
    await repository.ensureChannel(
      config.adminChannel.id,
      config.adminChannel.name,
    );

    const rankingAlgorithms = createDefaultRankingAlgorithmRegistry();
    const rankingAlgorithm = rankingAlgorithms.create(config.rankingAlgorithm);
    const rebuildProfile = new RebuildChannelProfile(
      repository,
      rankingAlgorithm,
    );
    if (options.exclusive) {
      for (const channel of await repository.listChannels()) {
        const rebuild = () => rebuildProfile.execute(channel.id, channel.name);
        if (repository.withChannelLock)
          await repository.withChannelLock(channel.id, rebuild);
        else await rebuild();
      }
    }
    const inference = new LiveInference(database, {
      enabled: config.llmProvider === "openai",
      baseUrl: config.openAiBaseUrl,
      model: config.openAiModel,
      revision: config.openAiModelRevision,
      timeoutMs: config.openAiTimeoutMs,
      weight: config.llmWeight,
      candidateLimit: config.llmCandidateLimit,
      apiKey: config.openAiApiKey,
    }, config.inferenceSettingsKey);
    await inference.initialize();
    const llm: LlmEvaluator = {
      get enabled() { return inference.activeEvaluator.enabled; },
      get name() { return inference.activeEvaluator.name; },
      get cacheIdentity() { return inference.activeEvaluator.cacheIdentity; },
      assess(input) { return inference.activeEvaluator.assess(input); },
    };
    const workflowStore = database ? new PostgresWorkflowStore(database) : null;
    const workflows = workflowStore ? new Workflows(workflowStore) : null;
    const actionQueue = new ActionQueue(
      100,
      workflowStore
        ? (action) => workflowStore.saveActivity(action)
        : undefined,
    );
    const ingestion = new IngestArticles(
      repository,
      sources,
      new HtmlContentExtractor(),
      config.articlesPerSource,
      actionQueue,
    );
    const ingestionCoordinator = new IngestionCoordinator(
      ingestion,
      actionQueue,
    );
    const rankFeed = new RankFeed(
      repository,
      rankingAlgorithm,
      llm,
      config.llmWeight,
      120,
      config.llmCandidateLimit,
      actionQueue,
      () => ({ llm: inference.activeEvaluator, weight: inference.activeWeight, candidateLimit: inference.activeCandidateLimit }),
    );
    workflows?.register("ingestion", () => ingestionCoordinator.execute());
    workflows?.register("evaluation", ({ channelId, channelName }) =>
      rankFeed.execute(channelId, channelName, { limit: 50 }),
    );
    const submitFeedback = new SubmitFeedback(
      repository,
      rankingAlgorithm,
      rebuildProfile,
      actionQueue,
    );
    const deliverFeed = new DeliverFeed(
      repository,
      rankFeed,
      actionQueue,
      workflows
        ? (channelId, channelName) =>
            workflows.enqueue(
              "evaluation",
              { channelId, channelName },
              `evaluation:${channelId}`,
            )
        : undefined,
    );

    return {
      async close() {
        await actionQueue.flush();
        await releaseOwner?.();
        await repository.close?.();
      },
      config,
      database,
      workflows,
      workflowStore,
      repository,
      rankingAlgorithms,
      rankingAlgorithm,
      llm,
      inference,
      actionQueue,
      ingestionCoordinator,
      rankFeed,
      submitFeedback,
      deliverFeed,
    };
  } catch (error) {
    await releaseOwner?.();
    await repository.close?.();
    throw error;
  }
}

export type AppContainer = Awaited<ReturnType<typeof createContainer>>;
