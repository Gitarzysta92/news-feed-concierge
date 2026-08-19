import type { ContentSource } from "../domain/ports.js";
import { DevCommunitySource } from "../infrastructure/sources/dev-community-source.js";
import { HackerNewsSource } from "../infrastructure/sources/hacker-news-source.js";

export class ContentSourceRegistry {
  private readonly sources = new Map<string, ContentSource>();

  register(source: ContentSource): this {
    if (!source.key.trim()) throw new Error("Content source key cannot be empty");
    if (!source.label.trim()) throw new Error(`Content source '${source.key}' needs a label`);
    if (!Number.isFinite(source.quality) || source.quality < 0 || source.quality > 1) {
      throw new Error(`Content source '${source.key}' quality must be between 0 and 1`);
    }
    if (this.sources.has(source.key)) throw new Error(`Content source is already registered: ${source.key}`);
    this.sources.set(source.key, source);
    return this;
  }

  all(): ContentSource[] {
    return [...this.sources.values()];
  }
}

export function createDefaultContentSourceRegistry(): ContentSourceRegistry {
  return new ContentSourceRegistry()
    .register(new HackerNewsSource())
    .register(new DevCommunitySource());
}
