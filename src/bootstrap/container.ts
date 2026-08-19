import { IngestArticles } from "../application/ingest-articles.js";
import { IngestionCoordinator } from "../application/ingestion-coordinator.js";
import { RankFeed } from "../application/rank-feed.js";
import { SubmitFeedback } from "../application/submit-feedback.js";
import { DeliverFeed } from "../application/deliver-feed.js";
import { ActionQueue } from "../application/action-queue.js";
import type { LlmEvaluator } from "../domain/ports.js";
import { config } from "../config.js";
import { OpenAiArticleEvaluator, DisabledLlmEvaluator } from "../infrastructure/llm/openai-article-evaluator.js";
import { CodexGatewayEvaluator } from "../infrastructure/llm/codex-gateway-evaluator.js";
import { HtmlContentExtractor } from "../infrastructure/sources/html-content-extractor.js";
import { SqliteConciergeRepository } from "../infrastructure/sqlite/sqlite-repository.js";
import { createDefaultContentSourceRegistry } from "./content-source-registry.js";
import { createDefaultRankingAlgorithmRegistry } from "./ranking-algorithm-registry.js";

export async function createContainer() {
  const sources = createDefaultContentSourceRegistry().all();
  const repository = new SqliteConciergeRepository(config.databaseFile);
  await repository.initialize();
  await Promise.all(sources.map((source) => (
    repository.updateSourceMetadata(source.key, source.label, source.quality)
  )));
  await repository.ensureChannel(config.adminChannel.id, config.adminChannel.name);
  for (const channel of config.discord.channels) await repository.ensureChannel(channel.id, channel.name);

  const rankingAlgorithms = createDefaultRankingAlgorithmRegistry();
  const rankingAlgorithm = rankingAlgorithms.create(config.rankingAlgorithm);
  const llm: LlmEvaluator = createLlmEvaluator();
  const actionQueue = new ActionQueue();
  const ingestion = new IngestArticles(
    repository,
    sources,
    new HtmlContentExtractor(),
    config.articlesPerSource,
    actionQueue,
  );
  const ingestionCoordinator = new IngestionCoordinator(ingestion, actionQueue);
  const rankFeed = new RankFeed(
    repository,
    rankingAlgorithm,
    llm,
    config.llmWeight,
    120,
    config.llmCandidateLimit,
    actionQueue,
  );
  const submitFeedback = new SubmitFeedback(repository, rankingAlgorithm, actionQueue);
  const deliverFeed = new DeliverFeed(repository, rankFeed, actionQueue);

  return {
    config,
    repository,
    rankingAlgorithms,
    rankingAlgorithm,
    llm,
    actionQueue,
    ingestionCoordinator,
    rankFeed,
    submitFeedback,
    deliverFeed,
  };
}

function createLlmEvaluator(): LlmEvaluator {
  if (config.llmProvider === "codex-gateway") {
    return config.codexGateway.apiToken
      ? new CodexGatewayEvaluator(
          config.codexGateway.url,
          config.codexGateway.apiToken,
          config.codexGateway.timeoutMs,
          config.codexGateway.pollIntervalMs,
        )
      : new DisabledLlmEvaluator("Codex Text Gateway (missing token)");
  }
  if (config.llmProvider === "openai") {
    return config.openAiApiKey
      ? new OpenAiArticleEvaluator(config.openAiApiKey, config.openAiModel)
      : new DisabledLlmEvaluator("OpenAI (missing key)");
  }
  return new DisabledLlmEvaluator();
}

export type AppContainer = Awaited<ReturnType<typeof createContainer>>;
