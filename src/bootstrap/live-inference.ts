import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { LlmEvaluator } from "../domain/ports.js";
import { DisabledLlmEvaluator, OpenAiArticleEvaluator } from "../infrastructure/llm/openai-article-evaluator.js";
import type { PostgresDatabase } from "../infrastructure/postgres/database.js";

const settingsSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.url().refine((url) => /^https?:\/\//.test(url), "Use an HTTP(S) URL"),
  model: z.string().trim().min(1).max(200),
  revision: z.string().trim().min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(600000),
  weight: z.number().min(0).max(1),
  candidateLimit: z.number().int().min(0).max(25),
});
export const inferenceUpdateSchema = settingsSchema.extend({
  apiKey: z.string().max(4096).optional(),
  clearApiKey: z.boolean().optional(),
});
type Settings = z.infer<typeof settingsSchema>;
type Update = z.infer<typeof inferenceUpdateSchema>;

export class LiveInference {
  private settings: Settings;
  private apiKey: string | undefined;
  private evaluator: LlmEvaluator;
  private source: "environment" | "saved" = "environment";
  private updatedAt: string | null = null;
  private readonly encryptionKey: Buffer | null;

  constructor(
    private readonly database: PostgresDatabase | null,
    defaults: Settings & { apiKey?: string },
    keyHex?: string,
  ) {
    this.settings = settingsSchema.parse(defaults);
    this.apiKey = defaults.apiKey;
    this.encryptionKey = keyHex && /^[a-f0-9]{64}$/i.test(keyHex) ? Buffer.from(keyHex, "hex") : null;
    this.evaluator = this.makeEvaluator();
  }

  async initialize() {
    if (!this.database || !this.encryptionKey) return;
    const { rows } = await this.database.query<{ settings: Settings; encrypted_api_key: string | null; updated_at: Date }>(
      "SELECT settings, encrypted_api_key, updated_at FROM inference_settings WHERE id=1",
    );
    if (!rows.length) return;
    this.settings = settingsSchema.parse(rows[0].settings);
    this.apiKey = rows[0].encrypted_api_key ? this.decrypt(rows[0].encrypted_api_key) : undefined;
    this.source = "saved";
    this.updatedAt = rows[0].updated_at.toISOString();
    this.evaluator = this.makeEvaluator();
  }

  get available() { return Boolean(this.database && this.encryptionKey); }
  get activeEvaluator() { return this.evaluator; }
  get activeWeight() { return this.settings.weight; }
  get activeCandidateLimit() { return this.settings.candidateLimit; }
  snapshot() {
    return { ...this.settings, hasApiKey: Boolean(this.apiKey), source: this.source, updatedAt: this.updatedAt };
  }

  async update(input: Update) {
    if (!this.database || !this.encryptionKey) throw new Error("Live inference settings require PostgreSQL and INFERENCE_SETTINGS_KEY");
    const parsed = inferenceUpdateSchema.parse(input);
    const { apiKey, clearApiKey, ...settings } = parsed;
    const nextKey = clearApiKey ? undefined : apiKey?.trim() || this.apiKey;
    const evaluator = this.makeEvaluator(settings, nextKey);
    const encrypted = nextKey ? this.encrypt(nextKey) : null;
    const { rows } = await this.database.query<{ updated_at: Date }>(
      `INSERT INTO inference_settings(id, settings, encrypted_api_key)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET settings=EXCLUDED.settings,
         encrypted_api_key=EXCLUDED.encrypted_api_key, updated_at=now()
       RETURNING updated_at`,
      [JSON.stringify(settings), encrypted],
    );
    this.settings = settings;
    this.apiKey = nextKey;
    this.evaluator = evaluator;
    this.source = "saved";
    this.updatedAt = rows[0].updated_at.toISOString();
    return this.snapshot();
  }

  private makeEvaluator(settings = this.settings, apiKey = this.apiKey): LlmEvaluator {
    if (!settings.enabled) return new DisabledLlmEvaluator();
    if (!apiKey) return new DisabledLlmEvaluator("OpenAI (missing key)");
    return new OpenAiArticleEvaluator(apiKey, settings.model, {
      baseURL: settings.baseUrl, revision: settings.revision, timeoutMs: settings.timeoutMs,
    });
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey!, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
  }

  private decrypt(value: string) {
    const [iv, tag, data] = value.split(".").map((part) => Buffer.from(part, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey!, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  }
}
