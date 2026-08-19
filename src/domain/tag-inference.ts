const TOPICS: Record<string, readonly string[]> = {
  ai: ["ai", "artificial intelligence", "machine learning", "llm", "gpt", "transformer", "inference", "openrouter"],
  typescript: ["typescript", "node.js", "nodejs", "javascript"],
  architecture: ["architecture", "distributed system", "microservice", "monolith", "domain-driven"],
  database: ["database", "sqlite", "postgres", "mysql", "query", "storage"],
  security: ["security", "vulnerability", "exploit", "authentication", "encryption", "privacy", "surveillance", "police state"],
  cloud: ["kubernetes", "cloud", "aws", "azure", "gcp", "container", "docker"],
  web: ["browser", "frontend", "react", "css", "web platform"],
  devtools: ["developer tool", "compiler", "runtime", "cli", "debugger"],
  open_source: ["open source", "github", "license"],
  gpu: ["cuda", "gpu", "graphics processor", "parallel computing"],
  biotech: ["mrna", "melanoma", "clinical trial", "therapy"],
  workplace: ["remote work", "remote worker", "work from home", "hybrid work", "employee well-being"],
  geopolitics: ["geopolitical", "warfare", "government department"],
};

const TITLE_STOP_WORDS = new Set([
  "about", "after", "against", "article", "avoid", "being", "could", "first", "from", "highest",
  "into", "more", "report", "reports", "should", "study", "that", "their", "this", "using", "what",
  "when", "where", "which", "while", "with", "without", "would", "years",
]);

export function inferTags(text: string, existing: string[] = []): string[] {
  const normalized = text.toLowerCase();
  const inferred = Object.entries(TOPICS)
    .filter(([, terms]) => terms.some((term) => containsTerm(normalized, term)))
    .map(([topic]) => topic);
  return [...new Set([...existing.map((tag) => tag.toLowerCase()), ...inferred])].slice(0, 10);
}

export function inferArticleTags(title: string, context: string, existing: string[] = []): string[] {
  const classified = inferTags(`${title} ${context}`, existing);
  if (classified.length > 0) return classified;
  const fallback = title
    .toLowerCase()
    .match(/[a-z][a-z0-9+#.-]{2,}/g)
    ?.map((token) => token.replace(/[^a-z0-9+#.-]+$/g, ""))
    .filter((token) => token.length >= 4 && !TITLE_STOP_WORDS.has(token)) ?? [];
  return [...new Set(fallback)].slice(0, 3);
}

function containsTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(text);
}
