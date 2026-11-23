import type { ChatHistoryItem, PromptLog } from "core";

// Theme colours for the breakdown, in segment order (system, tools,
// conversation). Distinct in every theme (accent and link are both blue in
// most), and not warning or error, which the ring uses for "near the limit"
// and "pruned".
const SEGMENT_COLORS = ["bg-description", "bg-success", "bg-link"];

export function segmentColor(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length];
}

/** 1.7K, 343.2K, 1.05M */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  }
  if (tokens >= 1000) {
    return `${Number((tokens / 1000).toFixed(1))}K`;
  }
  return String(tokens);
}

export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export interface ModelUsage {
  modelTitle: string;
  provider: string;
  requests: number;
  /** Responses whose provider sent no usage: their tokens aren't counted */
  withoutUsage: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** Sum over the priced requests only */
  costUsd: number;
  pricedRequests: number;
  priceSources: NonNullable<PromptLog["priced"]>[];
}

/**
 * What each model used in the session, from the provider usage saved with
 * each chat response. Most tokens first.
 */
export function sessionUsageByModel(history: ChatHistoryItem[]): ModelUsage[] {
  const byModel = new Map<string, ModelUsage>();
  for (const item of history) {
    for (const log of item.promptLogs ?? []) {
      const key = `${log.modelProvider}\u0000${log.modelTitle}`;
      let model = byModel.get(key);
      if (!model) {
        model = {
          modelTitle: log.modelTitle,
          provider: log.modelProvider,
          requests: 0,
          withoutUsage: 0,
          input: 0,
          cached: 0,
          cacheWrite: 0,
          output: 0,
          reasoning: 0,
          costUsd: 0,
          pricedRequests: 0,
          priceSources: [],
        };
        byModel.set(key, model);
      }
      model.requests += 1;
      const usage = log.usage;
      if (usage) {
        model.input += usage.promptTokens;
        model.cached += usage.promptTokensDetails?.cachedTokens ?? 0;
        model.cacheWrite += usage.promptTokensDetails?.cacheWriteTokens ?? 0;
        model.output += usage.completionTokens;
        model.reasoning += usage.completionTokensDetails?.reasoningTokens ?? 0;
      } else {
        model.withoutUsage += 1;
      }
      if (log.costUsd !== undefined) {
        model.costUsd += log.costUsd;
        model.pricedRequests += 1;
        if (log.priced && !model.priceSources.includes(log.priced)) {
          model.priceSources.push(log.priced);
        }
      }
    }
  }
  return [...byModel.values()].sort(
    (a, b) => b.input + b.output - (a.input + a.output),
  );
}

/** Which response of the session (1 for the first) made the tool call */
export function responseNumber(
  history: ChatHistoryItem[],
  toolCallId: string,
): number | undefined {
  let response = 0;
  for (const item of history) {
    if (item.message.role !== "assistant") {
      continue;
    }
    response += 1;
    if (item.toolCallStates?.some((state) => state.toolCallId === toolCallId)) {
      return response;
    }
  }
  return undefined;
}
