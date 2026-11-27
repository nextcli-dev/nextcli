import { ModelConfig } from "@nextcli/config-yaml";
import type { ChatHistoryItem } from "core/index.js";

import { ToolCall } from "../tools/index.js";
import { countTotalInputTokens, getModelMaxTokens } from "../util/tokenizer.js";

import type { AgentLoopBudget } from "./agentLoopLimits.js";
import { estimateFinalAnswerCost } from "./streamChatResponse.helpers.js";
import type { Prefix } from "./turnPrefix.js";

/** A compaction's summary request: the turn it summarizes */
export interface SummaryRequest extends Prefix {
  /** The turn's thinking budget doesn't fit the summary's output cap */
  thinkingOff?: boolean;
  /** The run that compacts, whose limits a second summary call must fit */
  runBudget?: AgentLoopBudget;
}

interface SummaryResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
}

/**
 * Why a summary response can't be stored: it called tools (they never run),
 * ran out of output tokens, or wrote nothing.
 */
function summaryProblem(response: SummaryResponse): string | undefined {
  if (response.toolCalls.length > 0) {
    return "The model answered the summary request with a tool call";
  }
  if (response.finishReason === "length") {
    return "The summary was cut off at its output limit";
  }
  if (!response.content.trim()) {
    return "The model returned an empty summary";
  }
  return undefined;
}

/**
 * The summary response to keep. The first call keeps the turn's tools and
 * thinking, so it reads the conversation from the provider's cache. One that
 * can't be stored is asked for once more without tools or thinking, which
 * misses the cache: only when the compacting run's limits leave room for
 * that call, which then counts as one of its calls. A summary still cut off
 * throws, so a stub never replaces the conversation; an empty one is
 * reported by compactChatHistory.
 */
export async function settleSummary<R extends SummaryResponse>(
  first: R,
  options: {
    summary?: SummaryRequest;
    /** The compaction's own, when no run is given (the /compact command) */
    budget: AgentLoopBudget;
    model: ModelConfig;
    chatHistory: ChatHistoryItem[];
    systemMessage: string;
    askAgain: () => Promise<R>;
    signal: AbortSignal;
  },
): Promise<R> {
  const { summary, model, signal } = options;
  let response = first;
  let problem = summaryProblem(response);
  // Without thinking, a cut-off summary would be cut off again
  const retryHelps =
    response.toolCalls.length > 0 ||
    !response.content.trim() ||
    !summary?.thinkingOff;
  if (problem && retryHelps && !signal.aborted) {
    const promptTokens = countTotalInputTokens({
      chatHistory: options.chatHistory,
      systemMessage: options.systemMessage,
      model,
    });
    const outputTokens = getModelMaxTokens(model);
    const allowed = (summary?.runBudget ?? options.budget).allowsExtraCall({
      tokens: promptTokens + outputTokens,
      cost: estimateFinalAnswerCost(model, promptTokens, outputTokens),
    });
    if (!allowed) {
      throw new Error(
        `${problem}, and the run's limits leave no room to ask again without tools, so the conversation was left as it is.`,
      );
    }
    response = await options.askAgain();
    problem = summaryProblem(response);
  }
  if (problem && response.content.trim() && !signal.aborted) {
    const hint =
      response.finishReason === "length"
        ? " Raise the output limit (maxTokens) for this model."
        : "";
    throw new Error(
      `${problem}, so the conversation was left as it is.${hint}`,
    );
  }
  return response;
}
