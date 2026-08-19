import { load } from "cheerio";
import type { SourceArticle } from "../../domain/model.js";
import type { ContentSource } from "../../domain/ports.js";
import { inferTags } from "../../domain/tag-inference.js";

const BASE_URL = "https://hacker-news.firebaseio.com/v0";

interface HackerNewsItem {
  id: number;
  type: string;
  by?: string;
  time?: number;
  text?: string;
  title?: string;
  url?: string;
  score?: number;
  deleted?: boolean;
  dead?: boolean;
}

export class HackerNewsSource implements ContentSource {
  readonly key = "hacker-news";
  readonly label = "Hacker News";
  readonly quality = 0.82;

  async fetchLatest(limit: number): Promise<SourceArticle[]> {
    const ids = await fetchJson<number[]>(`${BASE_URL}/beststories.json`);
    const items = await Promise.all(ids.slice(0, limit).map((id) => fetchJson<HackerNewsItem>(`${BASE_URL}/item/${id}.json`)));
    return items
      .filter((item) => item?.type === "story" && item.title && !item.dead && !item.deleted)
      .map((item) => {
        const sourceContent = stripHtml(item.text ?? "");
        const title = item.title ?? "Untitled";
        return {
          externalId: String(item.id),
          url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
          title,
          summary: sourceContent.slice(0, 500),
          sourceContent,
          author: item.by ?? null,
          tags: inferTags(`${title} ${sourceContent}`),
          imageUrl: null,
          popularity: item.score ?? 0,
          publishedAt: new Date((item.time ?? Date.now() / 1000) * 1000).toISOString(),
        };
      });
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "news-feed-concierge-poc/0.1" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Hacker News returned ${response.status}`);
  return response.json() as Promise<T>;
}

function stripHtml(html: string): string {
  return load(`<body>${html}</body>`)("body").text().replace(/\s+/g, " ").trim();
}
