import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { LiveInference } from "../src/bootstrap/live-inference.js";
import type { PostgresDatabase } from "../src/infrastructure/postgres/database.js";

const defaults = {
  enabled: true, baseUrl: "http://model:11434/v1", model: "initial-model",
  revision: "1", timeoutMs: 120000, weight: 0.3, candidateLimit: 2,
  apiKey: "initial-secret",
};

test("saved inference settings replace the active evaluator and survive restart with encrypted key", async () => {
  let stored: { settings: object; encrypted_api_key: string | null; updated_at: Date } | null = null;
  const database = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith("SELECT")) return { rows: stored ? [stored] : [] };
      stored = {
        settings: JSON.parse(values[0] as string) as object,
        encrypted_api_key: values[1] as string | null,
        updated_at: new Date(),
      };
      return { rows: [{ updated_at: stored.updated_at }] };
    },
  } as unknown as PostgresDatabase;
  const key = randomBytes(32).toString("hex");
  const live = new LiveInference(database, defaults, key);
  assert.equal(live.activeEvaluator.name, "initial-model@1");
  const saved = await live.update({
    enabled: true, baseUrl: "https://example.test/v1", model: "replacement-model",
    revision: "2", timeoutMs: 30000, weight: 0.6, candidateLimit: 4,
    apiKey: "replacement-secret",
  });
  assert.equal(live.activeEvaluator.name, "replacement-model@2");
  assert.equal(live.activeWeight, 0.6);
  assert.equal(live.activeCandidateLimit, 4);
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes("replacement-secret"), false);
  assert.equal(JSON.stringify(stored).includes("replacement-secret"), false);

  const restarted = new LiveInference(database, defaults, key);
  await restarted.initialize();
  assert.equal(restarted.snapshot().source, "saved");
  assert.equal(restarted.activeEvaluator.name, "replacement-model@2");
  await restarted.update({ ...restarted.snapshot(), model: "third-model" });
  assert.equal(restarted.snapshot().hasApiKey, true);
  assert.equal(JSON.stringify(stored).includes("replacement-secret"), false);
});

test("inference settings are unavailable until a 64-hex encryption key is present", () => {
  const database = { async query() { return { rows: [] }; } } as unknown as PostgresDatabase;
  const missing = new LiveInference(database, defaults);
  assert.equal(missing.available, false);
  assert.match(missing.unavailableReason ?? "", /INFERENCE_SETTINGS_KEY/);
  const padded = new LiveInference(database, defaults, `  ${randomBytes(32).toString("hex")}  `);
  assert.equal(padded.available, true);
  assert.equal(padded.unavailableReason, null);
});
