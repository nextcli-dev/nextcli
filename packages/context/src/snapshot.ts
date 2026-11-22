import type { ContextSegment, ContextSnapshot } from "./types.js";

export interface BuildSnapshotInput {
  window: number;
  threshold: ContextSnapshot["threshold"];
  segments: ContextSegment[];
  toolResults: { label: string; tokens: number }[];
  pruned?: { messages: number; tokens: number };
}

export function buildSnapshot(input: BuildSnapshotInput): ContextSnapshot {
  const used = input.segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const largestToolResults = [...input.toolResults]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);

  return {
    window: input.window,
    threshold: input.threshold,
    segments: input.segments,
    used,
    largestToolResults,
    ...(input.pruned ? { pruned: input.pruned } : {}),
  };
}
