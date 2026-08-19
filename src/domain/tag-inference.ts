const TOPICS: Record<string, readonly string[]> = {
  ai: ["artificial intelligence", "machine learning", "llm", "gpt", "transformer", "inference"],
  typescript: ["typescript", "node.js", "nodejs", "javascript"],
  architecture: ["architecture", "distributed system", "microservice", "monolith", "domain-driven"],
  database: ["database", "sqlite", "postgres", "mysql", "query", "storage"],
  security: ["security", "vulnerability", "exploit", "authentication", "encryption"],
  cloud: ["kubernetes", "cloud", "aws", "azure", "gcp", "container", "docker"],
  web: ["browser", "frontend", "react", "css", "web platform"],
  devtools: ["developer tool", "compiler", "runtime", "cli", "debugger"],
  open_source: ["open source", "github", "license"],
};

export function inferTags(text: string, existing: string[] = []): string[] {
  const normalized = text.toLowerCase();
  const inferred = Object.entries(TOPICS)
    .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
    .map(([topic]) => topic);
  return [...new Set([...existing.map((tag) => tag.toLowerCase()), ...inferred])].slice(0, 10);
}
