import { ClassicRankingAlgorithm } from "../domain/classic-ranking-algorithm.js";
import type { RankingAlgorithmDescriptor } from "../domain/model.js";
import type { RankingAlgorithm } from "../domain/ports.js";

export type RankingAlgorithmFactory = () => RankingAlgorithm;

export class RankingAlgorithmRegistry {
  private readonly factories = new Map<string, RankingAlgorithmFactory>();

  register(name: string, factory: RankingAlgorithmFactory): this {
    if (!name.trim()) throw new Error("Ranking algorithm name cannot be empty");
    if (this.factories.has(name)) throw new Error(`Ranking algorithm is already registered: ${name}`);
    this.factories.set(name, factory);
    return this;
  }

  create(name: string): RankingAlgorithm {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Unknown ranking algorithm '${name}'. Available: ${this.names().join(", ")}`);
    }
    const algorithm = factory();
    if (algorithm.name !== name) {
      throw new Error(`Ranking factory '${name}' returned '${algorithm.name}'`);
    }
    validateMetadata(algorithm);
    return algorithm;
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  describe(name: string): RankingAlgorithmDescriptor {
    const algorithm = this.create(name);
    return { id: algorithm.name, ...algorithm.metadata };
  }

  describeAll(): RankingAlgorithmDescriptor[] {
    return this.names().map((name) => this.describe(name));
  }
}

export function createDefaultRankingAlgorithmRegistry(): RankingAlgorithmRegistry {
  return new RankingAlgorithmRegistry()
    .register("interpretable-linear-v1", () => new ClassicRankingAlgorithm());
}

function validateMetadata(algorithm: RankingAlgorithm): void {
  const required = [
    algorithm.metadata.displayName,
    algorithm.metadata.version,
    algorithm.metadata.summary,
    algorithm.metadata.description,
    algorithm.metadata.learningStrategy,
  ];
  if (required.some((value) => !value.trim())) {
    throw new Error(`Ranking algorithm '${algorithm.name}' has incomplete metadata`);
  }
  const { min, max } = algorithm.metadata.scoreRange;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    throw new Error(`Ranking algorithm '${algorithm.name}' has an invalid score range`);
  }
}
