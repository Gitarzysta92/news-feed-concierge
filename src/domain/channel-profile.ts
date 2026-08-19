import type { ChannelProfile, FeatureWeights } from "./model.js";

const DEFAULT_WEIGHTS: FeatureWeights = {
  topicAffinity: 0.3,
  freshness: 0.22,
  novelty: 0.2,
  sourceQuality: 0.14,
  popularity: 0.14,
};

export function createDefaultProfile(id: string, name: string): ChannelProfile {
  return {
    id,
    name,
    weights: { ...DEFAULT_WEIGHTS },
    tagAffinities: {},
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}
