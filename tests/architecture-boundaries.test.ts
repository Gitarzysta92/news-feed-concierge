import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test("application layer does not import infrastructure", async () => {
  const files = await sourceFiles(join(projectRoot, "src/application"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*infrastructure\//, file);
  }
});

test("infrastructure layer does not import bootstrap", async () => {
  const files = await sourceFiles(join(projectRoot, "src/infrastructure"));
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*bootstrap\//, file);
  }
});

test("composition uses registries instead of concrete source and ranking constructors", async () => {
  const source = await readFile(join(projectRoot, "src/bootstrap/container.ts"), "utf8");
  assert.doesNotMatch(source, /new\s+(?:HackerNewsSource|DevCommunitySource|ClassicRankingAlgorithm)\b/);
  assert.match(source, /createDefaultContentSourceRegistry\(\)/);
  assert.match(source, /createDefaultRankingAlgorithmRegistry\(\)/);
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : Promise.resolve(path.endsWith(".ts") ? [path] : []);
  }));
  return nested.flat();
}
