import type { IngestionSummary } from "./ingest-articles.js";
import { IngestArticles } from "./ingest-articles.js";
import type { ActionQueue } from "./action-queue.js";

export class IngestionCoordinator {
  private current: Promise<IngestionSummary[]> | null = null;

  constructor(
    private readonly ingestion: IngestArticles,
    private readonly actions?: ActionQueue,
  ) {}

  get running(): boolean {
    return this.current !== null;
  }

  execute(): Promise<IngestionSummary[]> {
    if (this.current) return this.current;
    const action = this.actions?.enqueue({
      kind: "ingestion",
      label: "Collect latest technical articles",
      detail: "Fetching sources and scheduling full-text extraction",
    });
    action?.start();
    this.current = this.ingestion.execute()
      .then((summaries) => {
        const inserted = summaries.reduce((sum, summary) => sum + summary.inserted, 0);
        const extracted = summaries.reduce((sum, summary) => sum + summary.extracted, 0);
        action?.complete(`${inserted} new articles · ${extracted} full texts extracted`);
        return summaries;
      })
      .catch((error) => {
        action?.fail(error, "Article collection failed");
        throw error;
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }
}
