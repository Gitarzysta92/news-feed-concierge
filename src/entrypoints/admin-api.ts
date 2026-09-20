import { Router, type Express } from "express";
import { adminAuth } from "./admin-auth.js";

export interface AdminApiContainer {
  config: {
    inferenceAdminToken?: string;
    discord: { enabled: boolean };
  };
  runtime: { discord: { readonly connected: boolean } | null };
  repository: {
    stats(): Promise<{
      articles: number;
      extracted: number;
      evaluations: number;
      deliveries: number;
      feedback: number;
      channels: number;
      users: number;
    }>;
    listChannels(): Promise<Array<{ id: string; name: string; version: number; updatedAt: string }>>;
    listDeliveryTargets(deliveryInterface: string): Promise<unknown[]>;
    listUsers(limit: number): Promise<unknown[]>;
  };
  llm: { enabled: boolean; name: string };
  rankingAlgorithm: { name: string };
  ingestionCoordinator: { running: boolean; execute(): Promise<unknown> };
  inference: {
    available: boolean;
    snapshot(): unknown;
    update(input: unknown): Promise<unknown>;
  };
  workflows?: { enqueue(kind: string, payload?: Record<string, string>, key?: string): Promise<string> } | null;
  workflowStore?: {
    find(id: string): Promise<unknown>;
    snapshot(): Promise<unknown>;
  } | null;
  actionQueue: { flush(): Promise<unknown> | unknown; snapshot(): unknown };
}

const ADMIN_ENDPOINTS = [
  "GET /api/admin",
  "GET /api/admin/status",
  "POST /api/admin/ingestion",
  "POST /api/admin/delivery",
  "GET /api/admin/queue",
  "GET /api/admin/jobs/:jobId",
  "GET /api/admin/users",
  "GET /api/admin/channels",
  "GET /api/admin/delivery-targets",
  "GET /api/admin/settings/inference",
  "PUT /api/admin/settings/inference",
] as const;

export function mountAdminApi(app: Express, container: AdminApiContainer) {
  const admin = Router();
  admin.use(adminAuth(container));

  admin.get("/", (_request, response) => {
    response.json({
      token: "Authorization: Bearer $INFERENCE_ADMIN_TOKEN",
      endpoints: ADMIN_ENDPOINTS,
    });
  });

  admin.get("/status", async (_request, response, next) => {
    try {
      const [stats, channels, deliveryTargets] = await Promise.all([
        container.repository.stats(),
        container.repository.listChannels(),
        container.repository.listDeliveryTargets("discord"),
      ]);
      response.json({
        status: "ok",
        discord: {
          enabled: container.config.discord.enabled,
          connected: container.runtime.discord?.connected ?? false,
          deliveryTargets: deliveryTargets.length,
        },
        llm: {
          enabled: container.llm.enabled,
          provider: container.llm.name,
        },
        rankingAlgorithm: container.rankingAlgorithm.name,
        ingestionRunning: container.ingestionCoordinator.running,
        inferenceSettings: container.inference.available,
        stats,
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          revision: channel.version,
          updatedAt: channel.updatedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  admin.post("/ingestion", async (_request, response, next) => {
    try {
      if (container.workflows) {
        const jobId = await container.workflows.enqueue("ingestion");
        response.status(202).json({ jobId, status: "queued" });
        return;
      }
      const joinedExistingRun = container.ingestionCoordinator.running;
      const summaries = await container.ingestionCoordinator.execute();
      response.status(joinedExistingRun ? 200 : 202).json({ joinedExistingRun, summaries });
    } catch (error) {
      next(error);
    }
  });

  admin.post("/delivery", async (_request, response, next) => {
    try {
      if (!container.workflows) {
        response.status(503).json({ error: "Delivery requires PostgreSQL-backed workflows" });
        return;
      }
      if (!container.runtime.discord?.connected) {
        response.status(503).json({ error: "Discord is not connected" });
        return;
      }
      const jobId = await container.workflows.enqueue("delivery");
      response.status(202).json({ jobId, status: "queued" });
    } catch (error) {
      next(error);
    }
  });

  admin.get("/queue", async (_request, response, next) => {
    try {
      await container.actionQueue.flush();
      response.json(
        container.workflowStore
          ? await container.workflowStore.snapshot()
          : container.actionQueue.snapshot(),
      );
    } catch (error) {
      next(error);
    }
  });

  admin.get("/jobs/:jobId", async (request, response, next) => {
    try {
      const job = await container.workflowStore?.find(request.params.jobId);
      if (!job) {
        response.status(404).json({ error: "Job not found" });
        return;
      }
      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  admin.get("/users", async (request, response, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
      response.json({ users: await container.repository.listUsers(limit) });
    } catch (error) {
      next(error);
    }
  });

  admin.get("/channels", async (_request, response, next) => {
    try {
      const channels = await container.repository.listChannels();
      response.json({
        channels: channels.map((channel) => ({
          id: channel.id,
          name: channel.name,
          revision: channel.version,
          updatedAt: channel.updatedAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  admin.get("/delivery-targets", async (_request, response, next) => {
    try {
      response.json({
        targets: await container.repository.listDeliveryTargets("discord"),
      });
    } catch (error) {
      next(error);
    }
  });

  admin.use("/settings/inference", (_request, response, next) => {
    if (!container.inference.available) {
      response.status(503).json({
        error: "Inference settings require PostgreSQL and INFERENCE_SETTINGS_KEY (64 hex characters)",
      });
      return;
    }
    next();
  });

  admin.get("/settings/inference", (_request, response) => {
    response.json(container.inference.snapshot());
  });

  admin.put("/settings/inference", async (request, response, next) => {
    try {
      response.json(await container.inference.update(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/admin", admin);
}
