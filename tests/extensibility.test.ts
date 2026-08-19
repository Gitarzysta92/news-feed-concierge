import assert from "node:assert/strict";
import test from "node:test";
import { ContentSourceRegistry } from "../src/bootstrap/content-source-registry.js";
import { RankingAlgorithmRegistry } from "../src/bootstrap/ranking-algorithm-registry.js";
import { createDefaultProfile } from "../src/domain/channel-profile.js";
import { ClassicRankingAlgorithm } from "../src/domain/classic-ranking-algorithm.js";
import type { Article, ChannelProfile, RankingScore } from "../src/domain/model.js";
import type { ContentSource, RankingAlgorithm } from "../src/domain/ports.js";

test("an arbitrary source registers without domain-model or ranking-map changes", () => {
  const source: ContentSource = {
    key: "custom-tech-wire",
    label: "Custom Tech Wire",
    quality: 0.93,
    async fetchLatest() { return []; },
  };
  const registry = new ContentSourceRegistry().register(source);
  assert.deepEqual(registry.all(), [source]);

  const article = articleFrom(source);
  const result = new ClassicRankingAlgorithm().score(article, createDefaultProfile("channel", "Channel"), {
    now: new Date(article.publishedAt),
    recentlyDelivered: [],
  });
  assert.equal(result.features.sourceQuality, 0.93);
});

test("a custom ranking algorithm can be selected through the registry", () => {
  const algorithm: RankingAlgorithm = {
    name: "constant-test-v1",
    metadata: {
      displayName: "Constant Test Ranker",
      version: "1.0.0",
      summary: "A fixed-score test algorithm.",
      description: "Returns one stable value so registry substitution can be verified.",
      learningStrategy: "Does not change its fixed score.",
      capabilities: ["Deterministic scoring"],
      scoreRange: { min: 0, max: 1 },
      features: [{ key: "constant", label: "Constant", description: "A fixed input." }],
    },
    inspect(profile) {
      return { revision: profile.version, updatedAt: profile.updatedAt, groups: [] };
    },
    score(): RankingScore {
      return { score: 0.42, features: { constant: 1 }, contributions: { constant: 0.42 } };
    },
    learn(profile: ChannelProfile): ChannelProfile {
      return { ...profile, version: profile.version + 1 };
    },
  };
  const registry = new RankingAlgorithmRegistry().register(algorithm.name, () => algorithm);
  const selected = registry.create("constant-test-v1");
  assert.equal(selected.name, "constant-test-v1");
  assert.deepEqual(registry.describeAll(), [{ id: "constant-test-v1", ...algorithm.metadata }]);
  assert.equal(selected.inspect(createDefaultProfile("c", "C")).revision, 1);
  assert.equal(selected.score(articleFrom({ key: "x", label: "X", quality: 0.5 }), createDefaultProfile("c", "C"), {
    now: new Date(),
    recentlyDelivered: [],
  }).score, 0.42);
});

test("the active algorithm exposes algorithm-neutral live channel parameters", () => {
  const profile = {
    ...createDefaultProfile("live-channel", "Live Channel"),
    version: 4,
    tagAffinities: { typescript: 0.35, legacy: -0.2 },
  };
  const state = new ClassicRankingAlgorithm().inspect(profile);
  assert.equal(state.revision, 4);
  assert.equal(state.groups.find((group) => group.key === "feature-weights")?.parameters.length, 5);
  assert.deepEqual(
    state.groups.find((group) => group.key === "topic-affinities")?.parameters.map(({ key, value }) => ({ key, value })),
    [{ key: "typescript", value: 0.35 }, { key: "legacy", value: -0.2 }],
  );
});

function articleFrom(source: Pick<ContentSource, "key" | "label" | "quality">): Article {
  const now = new Date().toISOString();
  return {
    id: `${source.key}:1`,
    source: source.key,
    sourceLabel: source.label,
    sourceQuality: source.quality,
    externalId: "1",
    url: "https://example.com/article",
    title: "Custom technical article",
    summary: "Summary",
    content: "Full article text",
    contentStatus: "extracted",
    author: null,
    tags: ["architecture"],
    imageUrl: null,
    popularity: 5,
    publishedAt: now,
    fetchedAt: now,
  };
}
