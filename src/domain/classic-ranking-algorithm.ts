import type {
  Article,
  ChannelProfile,
  FeatureVector,
  RankingAlgorithmLiveState,
  RankingAlgorithmMetadata,
  RankingScore,
  RankingFeature,
} from "./model.js";
import { RANKING_FEATURES } from "./model.js";
import type { RankingAlgorithm, RankingContext } from "./ports.js";

const LEARNING_RATE = 0.12;

export class ClassicRankingAlgorithm implements RankingAlgorithm {
  readonly name = "interpretable-linear-v1";
  readonly metadata: RankingAlgorithmMetadata = {
    displayName: "Interpretable Linear Ranker",
    version: "1.0.0",
    summary: "A transparent weighted ranker that learns each channel's taste from reactions.",
    description: "Scores every article with a normalized weighted sum. Every feature and contribution remains inspectable, while the optional semantic evaluator can refine—but never replace—the base result.",
    learningStrategy: "Online supervised updates move feature weights and topic affinities toward the reaction target after every changed reaction. Learning is isolated per channel and creates a new profile version.",
    capabilities: [
      "Explainable feature contributions",
      "Per-channel online learning",
      "Topic-affinity adaptation",
      "Deterministic base scoring",
      "Hybrid semantic refinement",
    ],
    scoreRange: { min: 0, max: 1 },
    features: [
      { key: "topicAffinity", label: "Topic affinity", description: "How closely article tags match the channel's learned topic preferences." },
      { key: "freshness", label: "Freshness", description: "An exponential decay favoring recently published articles over older material." },
      { key: "novelty", label: "Novelty", description: "Dissimilarity from articles recently delivered to the same channel." },
      { key: "sourceQuality", label: "Source quality", description: "The quality prior declared by the article's source adapter." },
      { key: "popularity", label: "Popularity", description: "A bounded signal derived from engagement reported by the source." },
    ],
  };

  inspect(profile: ChannelProfile): RankingAlgorithmLiveState {
    const featureDescriptions = new Map(
      this.metadata.features.map((feature) => [feature.key, feature.description]),
    );
    return {
      revision: profile.version,
      updatedAt: profile.updatedAt,
      groups: [
        {
          key: "feature-weights",
          label: "Feature weights",
          description: "Mutable coefficients used by the normalized weighted score for this channel.",
          parameters: RANKING_FEATURES.map((feature) => ({
            key: feature,
            label: featureLabel(feature),
            description: featureDescriptions.get(feature) ?? feature,
            value: profile.weights[feature],
            min: 0.04,
            max: 1.5,
          })),
        },
        {
          key: "topic-affinities",
          label: "Learned topic affinities",
          description: "Reaction-derived preferences; positive values promote a topic and negative values reduce it.",
          parameters: Object.entries(profile.tagAffinities)
            .sort(([, left], [, right]) => Math.abs(right) - Math.abs(left))
            .map(([topic, value]) => ({
              key: topic,
              label: topic,
              description: `Learned affinity for ${topic}`,
              value,
              min: -1,
              max: 1,
            })),
        },
      ],
    };
  }

  score(article: Article, profile: ChannelProfile, context: RankingContext): RankingScore {
    const features: FeatureVector = {
      topicAffinity: topicAffinity(article, profile),
      freshness: freshness(article, context.now),
      novelty: novelty(article, context.recentlyDelivered),
      sourceQuality: article.sourceQuality,
      popularity: 1 - Math.exp(-Math.max(0, article.popularity) / 80),
    };

    const totalWeight = RANKING_FEATURES.reduce((sum, feature) => sum + profile.weights[feature], 0);
    const contributions = Object.fromEntries(
      RANKING_FEATURES.map((feature) => [
        feature,
        (features[feature] * profile.weights[feature]) / totalWeight,
      ]),
    ) as FeatureVector;

    const score = RANKING_FEATURES.reduce((sum, feature) => sum + contributions[feature], 0);
    return { score: clamp(score), features, contributions };
  }

  learn(
    profile: ChannelProfile,
    article: Article,
    score: RankingScore,
    target: number,
  ): ChannelProfile {
    const error = clamp(target) - score.score;
    const weights = { ...profile.weights };

    for (const feature of RANKING_FEATURES) {
      weights[feature] = clampRange(
        weights[feature] + LEARNING_RATE * error * score.features[feature],
        0.04,
        1.5,
      );
    }

    const tagAffinities = { ...profile.tagAffinities };
    for (const tag of article.tags) {
      const key = tag.toLowerCase();
      tagAffinities[key] = clampRange((tagAffinities[key] ?? 0) + LEARNING_RATE * error, -1, 1);
    }

    return {
      ...profile,
      weights,
      tagAffinities,
      version: profile.version + 1,
      updatedAt: new Date().toISOString(),
    };
  }
}

function topicAffinity(article: Article, profile: ChannelProfile): number {
  if (article.tags.length === 0) return 0.5;
  const total = article.tags.reduce(
    (sum, tag) => sum + (profile.tagAffinities[tag.toLowerCase()] ?? 0),
    0,
  );
  return clamp(0.5 + total / article.tags.length / 2);
}

function freshness(article: Article, now: Date): number {
  const ageHours = Math.max(0, now.getTime() - new Date(article.publishedAt).getTime()) / 3_600_000;
  return Math.exp(-ageHours / 72);
}

function novelty(article: Article, recent: Article[]): number {
  if (recent.length === 0) return 1;
  const candidate = tokens(article);
  const greatestOverlap = Math.max(...recent.map((item) => jaccard(candidate, tokens(item))));
  return clamp(1 - greatestOverlap);
}

function tokens(article: Article): Set<string> {
  const words = `${article.title} ${article.tags.join(" ")}`
    .toLowerCase()
    .match(/[a-z0-9+#.-]{3,}/g) ?? [];
  return new Set(words);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function clamp(value: number): number {
  return clampRange(value, 0, 1);
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function featureLabel(feature: RankingFeature): string {
  return feature.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}
