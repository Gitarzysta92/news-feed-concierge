import { load } from "cheerio";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ContentExtractor, ExtractedContent } from "../../domain/ports.js";

export class HtmlContentExtractor implements ContentExtractor {
  constructor(private readonly maxCharacters = 120_000) {}

  async extract(url: string): Promise<ExtractedContent> {
    const response = await safeFetch(new URL(url), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (compatible; NewsFeedConcierge/0.1; +https://github.com/)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Article returned ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("xhtml")) {
      throw new Error(`Unsupported content type: ${contentType || "unknown"}`);
    }

    const html = await response.text();
    const $ = load(html);
    const description = $('meta[name="description"]').attr("content")
      ?? $('meta[property="og:description"]').attr("content")
      ?? null;
    const imageUrl = $('meta[property="og:image"]').attr("content") ?? null;

    $("script, style, noscript, iframe, svg, nav, footer, header, form, aside").remove();
    const container = $("article").first().length
      ? $("article").first()
      : $("main").first().length
        ? $("main").first()
        : $('[role="main"]').first().length
          ? $('[role="main"]').first()
          : $("body");
    const text = container.text().replace(/\s+/g, " ").trim().slice(0, this.maxCharacters);
    if (text.length < 250) throw new Error("Article body was too short to evaluate");
    return { text, description: description?.trim() || null, imageUrl };
  }
}

async function safeFetch(initialUrl: URL, init: RequestInit): Promise<Response> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current);
  }
  throw new Error("Article redirected too many times");
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported article URL protocol");
  if (url.username || url.password) throw new Error("Article URL credentials are not allowed");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Private article host is not allowed");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private article host is not allowed");
  }
}

function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  const match = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const first = Number(match[1]);
  const second = Number(match[2]);
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || first >= 224;
}
