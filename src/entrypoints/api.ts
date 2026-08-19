import cors from "cors";
import express from "express";
import { z } from "zod";
import { REACTIONS } from "../domain/reactions.js";
import type { FeedbackReaction } from "../domain/model.js";
import type { AppContainer } from "../bootstrap/container.js";
import { createContainer } from "../bootstrap/container.js";

const feedbackSchema = z.object({
  channelId: z.string().min(1),
  channelName: z.string().min(1),
  articleId: z.string().min(1),
  actorId: z.string().min(1).default("admin"),
  reaction: z.enum(["👍", "🔥", "👎", "💤"]),
});

export function createApi(container: AppContainer) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: container.config.dashboardOrigin }));
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_request, response) => {
    response.json({
      status: "ok",
      llmEnabled: container.llm.enabled,
      llmProvider: container.llm.name,
      rankingAlgorithm: container.rankingAlgorithm.name,
      rankingAlgorithmMetadata: container.rankingAlgorithm.metadata,
      discordEnabled: container.config.discord.enabled,
      ingestionRunning: container.ingestionCoordinator.running,
    });
  });

  app.get("/api/dashboard", async (request, response, next) => {
    try {
      const channelId = String(request.query.channelId || container.config.adminChannel.id);
      const channelName = String(request.query.channelName || container.config.adminChannel.name);
      // Ranking may regenerate evaluations after feedback invalidates the cache.
      // Complete it before reading statistics so the dashboard snapshot is consistent.
      const ranked = await container.rankFeed.execute(channelId, channelName, {
        limit: 12,
        semanticMode: "cached-only",
      });
      const [stats, runs, channels, profile] = await Promise.all([
        container.repository.stats(),
        container.repository.listRuns(8),
        container.repository.listChannels(),
        container.repository.ensureChannel(channelId, channelName),
      ]);
      response.json({
        stats,
        runs,
        channels,
        profile,
        ranked: ranked.map(toRankedDto),
        reactions: REACTIONS,
        services: {
          ranking: `${container.rankingAlgorithm.metadata.displayName} v${container.rankingAlgorithm.metadata.version}`,
          llm: container.llm.enabled ? `enabled (${container.llm.name})` : container.llm.name,
          discord: container.config.discord.enabled ? "configured" : "not configured",
          ingestionRunning: container.ingestionCoordinator.running,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/algorithms", async (request, response, next) => {
    try {
      const channelId = String(request.query.channelId || container.config.adminChannel.id);
      const [channels, profile] = await Promise.all([
        container.repository.listChannels(),
        container.repository.findChannel(channelId),
      ]);
      if (!profile) {
        response.status(404).json({ error: `Channel not found: ${channelId}` });
        return;
      }
      response.json({
        active: container.rankingAlgorithm.name,
        algorithms: container.rankingAlgorithms.describeAll(),
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          revision: channel.version,
          updatedAt: channel.updatedAt,
        })),
        liveState: {
          algorithmId: container.rankingAlgorithm.name,
          channel: { id: profile.id, name: profile.name },
          ...container.rankingAlgorithm.inspect(profile),
        },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/algorithms/:algorithmId", (request, response, next) => {
    try {
      if (!container.rankingAlgorithms.names().includes(request.params.algorithmId)) {
        response.status(404).json({ error: `Ranking algorithm not found: ${request.params.algorithmId}` });
        return;
      }
      response.json({
        active: container.rankingAlgorithm.name === request.params.algorithmId,
        algorithm: container.rankingAlgorithms.describe(request.params.algorithmId),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/queue", (_request, response) => {
    response.json(container.actionQueue.snapshot());
  });

  app.get("/api/channels/:channelId/feed", async (request, response, next) => {
    try {
      const channelName = String(request.query.channelName || request.params.channelId);
      const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 10));
      const ranked = await container.rankFeed.execute(request.params.channelId, channelName, { limit });
      response.json(ranked.map(toRankedDto));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/feedback", async (request, response, next) => {
    try {
      const input = feedbackSchema.parse(request.body);
      const result = await container.submitFeedback.execute({
        ...input,
        reaction: input.reaction as FeedbackReaction,
        interface: "admin",
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/ingestion", async (_request, response, next) => {
    try {
      const joinedExistingRun = container.ingestionCoordinator.running;
      const summaries = await container.ingestionCoordinator.execute();
      response.status(joinedExistingRun ? 200 : 202).json({ joinedExistingRun, summaries });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next;
    const status = error instanceof z.ZodError ? 400 : error instanceof Error && error.message.includes("not found") ? 404 : 500;
    console.error(error);
    response.status(status).json({ error: error instanceof Error ? error.message : "Unexpected error" });
  });

  return app;
}

export async function startApi(container?: AppContainer) {
  const resolved = container ?? await createContainer();
  const app = createApi(resolved);
  return app.listen(resolved.config.apiPort, () => {
    console.log(`News Feed Concierge API listening on http://localhost:${resolved.config.apiPort}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startApi();
}

function toRankedDto(item: Awaited<ReturnType<AppContainer["rankFeed"]["execute"]>>[number]) {
  const { content, ...article } = item.article;
  void content;
  return { ...item, article };
}
