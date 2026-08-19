import type { FeedbackReaction } from "./model.js";

export interface ReactionDefinition {
  reaction: FeedbackReaction;
  label: string;
  signal: number;
  target: number;
}

export const REACTIONS: readonly ReactionDefinition[] = [
  { reaction: "👍", label: "Useful", signal: 1, target: 0.8 },
  { reaction: "🔥", label: "Must read", signal: 2, target: 1 },
  { reaction: "👎", label: "Not useful", signal: -1, target: 0 },
  { reaction: "💤", label: "Too familiar", signal: -0.5, target: 0.3 },
] as const;

export function reactionDefinition(reaction: string): ReactionDefinition | undefined {
  return REACTIONS.find((definition) => definition.reaction === reaction);
}
