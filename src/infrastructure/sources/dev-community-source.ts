import type { SourceArticle } from "../../domain/model.js";
import type { ContentSource } from "../../domain/ports.js";
import { inferTags } from "../../domain/tag-inference.js";

interface DevArticle {
  id: number;
  title: string;
  description: string;
  url: string;
  canonical_url?: string;
  cover_image?: string | null;
  social_image?: string | null;
  published_timestamp: string;
  tag_list: string[];
  public_reactions_count: number;
  comments_count: number;
  user?: { username?: string };
}

export class DevCommunitySource implements ContentSource {
  readonly key = "dev-community";
  readonly label = "DEV Community";
  readonly quality = 0.74;

  async fetchLatest(limit: number): Promise<SourceArticle[]> {
    const url = new URL("https://dev.to/api/articles");
    url.searchParams.set("per_page", String(Math.min(limit, 100)));
    url.searchParams.set("top", "7");
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.forem.api-v1+json",
        "user-agent": "news-feed-concierge-poc/0.1",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`DEV Community returned ${response.status}`);
    const articles = await response.json() as DevArticle[];
    return articles.map((article) => ({
      externalId: String(article.id),
      url: article.canonical_url || article.url,
      title: article.title,
      summary: article.description ?? "",
      sourceContent: article.description ?? "",
      author: article.user?.username ?? null,
      tags: inferTags(`${article.title} ${article.description}`, article.tag_list ?? []),
      imageUrl: article.cover_image ?? article.social_image ?? null,
      popularity: article.public_reactions_count + article.comments_count * 2,
      publishedAt: new Date(article.published_timestamp).toISOString(),
    }));
  }
}
