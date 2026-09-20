import assert from "node:assert/strict";
import express from "express";
import test from "node:test";
import { mountAdminApi, type AdminApiContainer } from "../src/entrypoints/admin-api.js";

const TOKEN = "admin-token-16chars";

test("admin API requires a bearer token and reports operator status", async (context) => {
  const enqueued: string[] = [];
  const app = express();
  app.use(express.json());
  mountAdminApi(app, stubContainer({
    enqueue: async (kind) => {
      enqueued.push(kind);
      return "job-1";
    },
    discordConnected: true,
  }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;

  const unauthenticated = await fetch(`${origin}/api/admin/status`);
  assert.equal(unauthenticated.status, 401);

  const unauthorized = await fetch(`${origin}/api/admin/status`, {
    headers: { Authorization: "Bearer wrong-token-16ch" },
  });
  assert.equal(unauthorized.status, 401);

  const catalog = await fetchJson(`${origin}/api/admin`, TOKEN);
  assert.ok(Array.isArray(catalog.endpoints));
  assert.ok((catalog.endpoints as string[]).includes("GET /api/admin/status"));

  const status = await fetchJson(`${origin}/api/admin/status`, TOKEN);
  assert.equal(status.status, "ok");
  const discord = status.discord as { connected: boolean; deliveryTargets: number };
  const stats = status.stats as { articles: number };
  assert.equal(discord.connected, true);
  assert.equal(discord.deliveryTargets, 1);
  assert.equal(stats.articles, 3);

  const ingestion = await fetchJson(`${origin}/api/admin/ingestion`, TOKEN, { method: "POST" });
  assert.equal(ingestion.status, "queued");
  assert.equal(ingestion.jobId, "job-1");

  const delivery = await fetchJson(`${origin}/api/admin/delivery`, TOKEN, { method: "POST" });
  assert.equal(delivery.status, "queued");
  assert.deepEqual(enqueued, ["ingestion", "delivery"]);
});

test("admin delivery stays queued until Discord is connected", async (context) => {
  const app = express();
  app.use(express.json());
  mountAdminApi(app, stubContainer({ discordConnected: false }));
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/admin/delivery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 503);
  assert.match((await response.json() as { error: string }).error, /Discord is not connected/);
});

async function fetchJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  assert.ok(response.ok, `Expected success from ${url}, got ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function stubContainer(options: {
  enqueue?: (kind: string) => Promise<string>;
  discordConnected?: boolean;
} = {}) {
  return {
    config: {
      dashboardOrigin: "http://localhost:3000",
      inferenceAdminToken: TOKEN,
      discord: { enabled: true },
    },
    runtime: { discord: { connected: options.discordConnected ?? false } },
    repository: {
      async stats() {
        return { articles: 3, extracted: 2, evaluations: 0, deliveries: 1, feedback: 0, channels: 1, users: 1 };
      },
      async listChannels() {
        return [{ id: "admin-preview", name: "dashboard-preview", version: 1, updatedAt: "2026-01-01T00:00:00.000Z", weights: {}, tagAffinities: {} }];
      },
      async listDeliveryTargets() {
        return options.discordConnected
          ? [{ interface: "discord", channelId: "1", channelName: "news", installationId: "guild", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }]
          : [];
      },
      async listUsers() { return []; },
    },
    llm: { enabled: false, name: "disabled" },
    rankingAlgorithm: { name: "interpretable-linear-v1" },
    ingestionCoordinator: { running: false, async execute() { return []; } },
    inference: { available: false, snapshot() { return {}; }, async update() { return {}; } },
    workflows: options.enqueue
      ? { enqueue: async (kind: string) => options.enqueue!(kind) }
      : { enqueue: async (kind: string) => kind },
    workflowStore: { async find() { return null; }, async snapshot() { return { jobs: [], actions: [] }; } },
    actionQueue: { async flush() { return undefined; }, snapshot() { return { actions: [], counts: {} }; } },
  } as AdminApiContainer;
}
