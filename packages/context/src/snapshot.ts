import type { ContextSegment, ContextSnapshot } from "./types.js";

export interface BuildSnapshotInput {
  window: number;
  threshold: ContextSnapshot["threshold"];
  segments: ContextSegment[];
  toolResults: { label: string; tokens: number }[];
  pruned?: { messages: number; tokens: number };
}

function copySegment(segment: ContextSegment): ContextSegment {
  return {
    id: segment.id,
    label: segment.label,
    tokens: segment.tokens,
    source: segment.source,
    ...(segment.children
      ? { children: segment.children.map(copySegment) }
      : {}),
  };
}

export function buildSnapshot(input: BuildSnapshotInput): ContextSnapshot {
  const segments = input.segments.map(copySegment);
  // Children break a parent down. Their tokens are not added to `used`.
  const used = segments.reduce((sum, segment) => sum + segment.tokens, 0);
  const largestToolResults = [...input.toolResults]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .map((result) => ({ label: result.label, tokens: result.tokens }));

  return {
    window: input.window,
    threshold: {
      tokens: input.threshold.tokens,
      action: input.threshold.action,
      steps: input.threshold.steps.map((step) => ({
        label: step.label,
        tokens: step.tokens,
      })),
    },
    segments,
    used,
    largestToolResults,
    ...(input.pruned
      ? {
          pruned: {
            messages: input.pruned.messages,
            tokens: input.pruned.tokens,
          },
        }
      : {}),
  };
}
