import type { ContentExtractor, ContentSource, ConciergeRepository } from "../domain/ports.js";
import { inferTags } from "../domain/tag-inference.js";
import type { ActionQueue } from "./action-queue.js";

export interface IngestionSummary {
  source: string;
  fetched: number;
  inserted: number;
  extracted: number;
  failedExtractions: number;
}

export class IngestArticles {
  constructor(
    private readonly repository: ConciergeRepository,
    private readonly sources: ContentSource[],
    private readonly extractor: ContentExtractor,
    private readonly perSourceLimit: number,
    private readonly actions?: ActionQueue,
  ) {}

  async execute(): Promise<IngestionSummary[]> {
    const summaries: IngestionSummary[] = [];
    for (const source of this.sources) summaries.push(await this.ingestSource(source));
    return summaries;
  }

  private async ingestSource(source: ContentSource): Promise<IngestionSummary> {
    const run = await this.repository.startRun(source.key);
    let fetched = 0;
    let inserted = 0;
    let extracted = 0;
    let failedExtractions = 0;

    try {
      const incoming = await source.fetchLatest(this.perSourceLimit);
      fetched = incoming.length;

      const queued = incoming.map((item) => ({
        item,
        action: this.actions?.enqueue({
          kind: "extraction",
          label: item.title,
          detail: `Waiting to process full text from ${source.label}`,
          context: { source: source.key, articleUrl: item.url },
        }),
      }));

      await mapWithConcurrency(queued, 5, async ({ item, action }) => {
        action?.start(`Checking stored content from ${source.label}`);
        try {
          const initial = await this.repository.upsertArticle({
            ...item,
            source: source.key,
            sourceLabel: source.label,
            sourceQuality: source.quality,
            content: item.sourceContent,
            contentStatus: item.sourceContent ? "source-only" : "failed",
          });
          if (initial.inserted) inserted += 1;
          if (initial.article.contentStatus === "extracted") {
            action?.complete("Full text already stored; no extraction needed");
            return;
          }

          try {
            const full = await this.extractor.extract(item.url);
            const tags = inferTags(`${item.title} ${full.description ?? item.summary} ${full.text}`, item.tags);
            await this.repository.upsertArticle({
              ...item,
              source: source.key,
              sourceLabel: source.label,
              sourceQuality: source.quality,
              summary: full.description ?? item.summary,
              content: full.text,
              contentStatus: "extracted",
              tags,
              imageUrl: full.imageUrl ?? item.imageUrl,
            });
            extracted += 1;
            action?.complete(`${full.text.length.toLocaleString()} characters extracted`);
          } catch (error) {
            failedExtractions += 1;
            action?.fail(error, "Full-text extraction failed; source content retained");
          }
        } catch (error) {
          action?.fail(error, "Article processing failed");
          throw error;
        }
      });

      await this.repository.finishRun(run.id, {
        status: "completed",
        fetchedCount: fetched,
        newCount: inserted,
        extractedCount: extracted,
      });
      return { source: source.key, fetched, inserted, extracted, failedExtractions };
    } catch (error) {
      await this.repository.finishRun(run.id, {
        status: "failed",
        fetchedCount: fetched,
        newCount: inserted,
        extractedCount: extracted,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await work(items[index]);
    }
  }));
}
