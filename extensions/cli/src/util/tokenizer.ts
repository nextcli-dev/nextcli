import { ModelConfig } from "@nextcli/config-yaml";
import { countToolTokens, memoizeCount } from "@nextcli/context";
import type { ChatHistoryItem, Reasoning } from "core/index.js";
import { getAdjustedTokenCountFromModel } from "core/llm/getAdjustedTokenCount.js";
import { encode } from "gpt-tokenizer";
import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

import type { ToolCall } from "../tools/types.js";

import { logger } from "./logger.js";
import { getModelControlsFor, getModelSettings } from "./modelSettings.js";

/**
 * One cached count for every long text. Special-token markers such as
 * `<|endoftext|>` are counted as ordinary text.
 */
export const countText = memoizeCount(
  (text: string) => encode(text, { disallowedSpecial: new Set() }).length,
);

const DEFAULT_MAX_TOKENS_RATIO = 0.35;
const MAX_MAX_TOKENS = 64_000;
// Default context length when model config doesn't specify one
export const DEFAULT_CONTEXT_LENGTH = 200_000;

/**
 * The model's window from the models.dev catalog, capped at the default. A
 * smaller window is the model's real limit. A larger one (1M for some Claude
 * and DeepSeek models) is chosen in the config or the model menu: by
 * default, compaction runs at the same point, and the prices that rise above
 * 200K tokens aren't reached.
 */
function catalogContextLimit(model: ModelConfig): number | undefined {
  const limit = getModelControlsFor(model).maxContextLength;
  return limit === undefined
    ? undefined
    : Math.min(limit, DEFAULT_CONTEXT_LENGTH);
}

/**
 * The context window before any model-menu choice: the config's
 * (`defaultCompletionOptions.contextLength`, then `contextLength`), else the
 * catalog's, else the default
 */
export function configuredContextLimit(model: ModelConfig): number {
  return (
    model.defaultCompletionOptions?.contextLength ??
    model.contextLength ??
    catalogContextLimit(model) ??
    DEFAULT_CONTEXT_LENGTH
  );
}

/**
 * Get the context length limit for a model
 * @param model The model config
 * @returns The context length limit in tokens
 */
export function getModelContextLimit(model: ModelConfig): number {
  // A window chosen in the model menu takes precedence over the config
  return getModelSettings(model).contextLength ?? configuredContextLimit(model);
}

export function getModelMaxTokens(model: ModelConfig): number {
  const contextLimit = getModelContextLimit(model);
  const maxTokens = model.defaultCompletionOptions?.maxTokens;

  return maxTokens === undefined
    ? Math.ceil(
        Math.min(contextLimit * DEFAULT_MAX_TOKENS_RATIO, MAX_MAX_TOKENS),
      )
    : maxTokens;
}

/**
 * Count tokens in message content (string or multimodal array)
 */
function countContentTokens(
  content: string | any[],
  model: ModelConfig,
): number {
  if (typeof content === "string") {
    const count = countText(content);
    return getAdjustedTokenCountFromModel(count, model.model ?? "");
  }

  if (Array.isArray(content)) {
    let tokenCount = 0;
    for (const part of content) {
      if (part.type === "text" && part.text) {
        tokenCount += countText(part.text);
      }
      if (part.type === "imageUrl") {
        tokenCount += 1024; // Rough estimate for image tokens
      }
    }
    return getAdjustedTokenCountFromModel(tokenCount, model.model ?? "");
  }

  return 0;
}

/**
 * Count tokens in a single tool call function
 */
function countToolCallFunctionTokens(
  toolCallFunction: { name?: string; arguments?: string } | undefined,
): number {
  if (!toolCallFunction) {
    return 0;
  }

  let tokenCount = 0;
  tokenCount += countText(toolCallFunction.name ?? "") + 10; // Function name and structure overhead
  tokenCount += countText(toolCallFunction.arguments ?? ""); // Arguments
  return tokenCount;
}

/**
 * Count tokens in tool call outputs
 */
export function countToolOutputTokens(
  output: Array<{ content?: string; name?: string }> | undefined,
): number {
  if (!output) {
    return 0;
  }

  let tokenCount = 0;
  for (const item of output) {
    if (item.content) {
      tokenCount += countText(item.content);
    }
    // Note: item.name is not sent to the model, only used for internal tracking
    tokenCount += 5; // Output structure overhead
  }
  return tokenCount;
}

/**
 * Estimate the token count for a single ChatHistoryItem
 * @param historyItem The ChatHistoryItem to count tokens for
 * @returns The estimated token count
 */
/**
 * Tokens for reasoning sent back with a message. Structured details hold
 * everything sent: readable text and summaries, plus signatures and
 * encrypted data, which are estimated at 4 characters per token. Without
 * details, only the text is sent.
 */
export function countReasoningTokens(reasoning: Reasoning): number {
  if (!reasoning.details?.length) {
    return reasoning.text ? countText(reasoning.text) : 0;
  }
  let tokens = 0;
  for (const detail of reasoning.details) {
    for (const readable of [detail.text, detail.summary]) {
      if (typeof readable === "string" && readable) {
        tokens += countText(readable);
      }
    }
    for (const opaque of [detail.signature, detail.data]) {
      if (typeof opaque === "string" && opaque) {
        tokens += Math.ceil(opaque.length / 4);
      }
    }
  }
  return tokens;
}

export interface HistoryItemParts {
  role: string;
  messageTokens: number;
  reasoningTokens: number;
  toolResults: { label: string; tokens: number }[];
}

/** The same pieces `countChatHistoryItemTokens` adds, split for the snapshot. */
export function historyItemParts(
  historyItem: ChatHistoryItem,
  model: ModelConfig,
): HistoryItemParts {
  const message = historyItem.message;
  let messageTokens = 2;
  const toolResults: { label: string; tokens: number }[] = [];

  if (message.role === "tool") {
    messageTokens += 5;
    toolResults.push({
      label:
        "toolCallId" in message && message.toolCallId
          ? message.toolCallId
          : "Tool result",
      tokens: countContentTokens(message.content, model),
    });
  } else {
    messageTokens += countContentTokens(message.content, model);
  }

  // Skip if toolCallStates exists to avoid double-counting (toolCallStates includes the tool calls)
  if (
    "toolCalls" in message &&
    message.toolCalls &&
    !historyItem.toolCallStates
  ) {
    for (const toolCall of message.toolCalls) {
      messageTokens += countToolCallFunctionTokens(toolCall.function);
    }
  }

  for (const contextItem of historyItem.contextItems) {
    messageTokens += countText(contextItem.content);
    messageTokens += countText(contextItem.name);
    messageTokens += 5;
  }

  const reasoningTokens = historyItem.reasoning
    ? countReasoningTokens(historyItem.reasoning)
    : 0;

  if (historyItem.toolCallStates) {
    for (const toolState of historyItem.toolCallStates) {
      messageTokens += countToolCallFunctionTokens(
        toolState.toolCall?.function,
      );
      const tokens = countToolOutputTokens(toolState.output);
      if (tokens > 0) {
        toolResults.push({
          label: toolState.toolCall?.function?.name || "Tool result",
          tokens,
        });
      }
    }
  }

  return {
    role: message.role,
    messageTokens,
    reasoningTokens,
    toolResults,
  };
}

export function countChatHistoryItemTokens(
  historyItem: ChatHistoryItem,
  model: ModelConfig,
): number {
  try {
    const parts = historyItemParts(historyItem, model);
    return (
      parts.messageTokens +
      parts.reasoningTokens +
      parts.toolResults.reduce((sum, result) => sum + result.tokens, 0)
    );
  } catch (error) {
    logger.error("Error counting tokens for history item", error);
    // Return a rough estimate based on character count
    const message = historyItem.message;
    const content =
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    // Add rough estimate for context items
    const contextContent = historyItem.contextItems
      .map((item) => item.content + item.name)
      .join("");
    return Math.ceil((content.length + contextContent.length) / 4); // Rough estimate: 4 chars per token
  }
}

/**
 * Estimate the total token count for a chat history
 * @param chatHistory The chat history to count tokens for
 * @returns The estimated total token count
 */
/**
 * The history items a model request carries. role:"system" items are TUI
 * notices, plus in `cn serve` a copy of the system prompt, which every request
 * sends separately. Requests and token counts both go through this, so they
 * agree on what is sent.
 */
export function historySentToModel(
  chatHistory: ChatHistoryItem[],
): ChatHistoryItem[] {
  return chatHistory.filter((item) => item.message.role !== "system");
}

export function countChatHistoryTokens(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
): number {
  const sent = historySentToModel(chatHistory);
  let totalTokens = 0;

  for (const historyItem of sent) {
    totalTokens += countChatHistoryItemTokens(historyItem, model);
  }

  // Add some overhead for message structure (roughly 3 tokens per message)
  totalTokens += sent.length * 3;

  return totalTokens;
}

/**
 * Calculate the percentage of context used
 * @param tokenCount Current token count
 * @param modelName The model name
 * @returns The percentage of context used (0-100)
 */
export function calculateContextUsagePercentage(
  tokenCount: number,
  model: ModelConfig,
): number {
  const limit = getModelContextLimit(model);
  return Math.min(100, Math.round((tokenCount / limit) * 100));
}

/** The whole tool schema, including nested fields, plus the list overhead. */
export function countToolDefinitionTokens(tools: ChatCompletionTool[]): number {
  return countToolTokens(tools, countText).total;
}

/**
 * Parameters for calculating total input tokens including all components
 */
export interface TotalInputTokenParams {
  chatHistory: ChatHistoryItem[];
  model: ModelConfig;
  systemMessage?: string;
  tools?: ChatCompletionTool[];
}

/**
 * Calculate total input tokens including chat history, system message, and tool definitions.
 * This provides a complete picture of tokens that will be sent to the API.
 * @param params Object containing chatHistory, optional systemMessage, optional tools, and optional modelName
 * @returns Total estimated input token count
 */
export function countTotalInputTokens(params: TotalInputTokenParams): number {
  const { chatHistory, systemMessage, tools } = params;

  let totalTokens = countChatHistoryTokens(chatHistory, params.model);

  if (systemMessage) {
    totalTokens += countText(systemMessage);
    totalTokens += 4; // Message structure overhead (role + formatting)
  }

  // Add tool definition tokens
  if (tools && tools.length > 0) {
    totalTokens += countToolDefinitionTokens(tools);
  }

  return totalTokens;
}

/**
 * Parameters for context length validation
 */
export interface ValidateContextLengthParams {
  chatHistory: ChatHistoryItem[];
  model: ModelConfig;
  safetyBuffer?: number;
  systemMessage?: string;
  tools?: ChatCompletionTool[];
}

/**
 * Validates that the input tokens + max_tokens don't exceed context limit.
 * Accounts for system message and tool definitions in the calculation.
 * @param params Object containing chatHistory, model, optional safetyBuffer, systemMessage, and tools
 * @returns Validation result with error details if invalid
 */
export function validateContextLength(params: ValidateContextLengthParams): {
  isValid: boolean;
  error?: string;
  inputTokens?: number;
  contextLimit?: number;
  maxTokens?: number;
} {
  const { chatHistory, model, safetyBuffer = 0, systemMessage, tools } = params;

  const inputTokens = countTotalInputTokens({
    chatHistory,
    systemMessage,
    tools,
    model,
  });
  const contextLimit = getModelContextLimit(model);
  // The same reserve compaction plans with, so a history that compaction
  // let through also passes here
  const reservedForOutput = getModelMaxTokens(model);
  const totalRequired = inputTokens + reservedForOutput + safetyBuffer;

  if (totalRequired > contextLimit) {
    return {
      isValid: false,
      error: `Context length exceeded: input (${inputTokens.toLocaleString()}) + max_tokens (${reservedForOutput.toLocaleString()})${safetyBuffer > 0 ? ` + buffer (${safetyBuffer})` : ""} = ${totalRequired.toLocaleString()} > context_limit (${contextLimit.toLocaleString()})`,
      inputTokens,
      contextLimit,
      maxTokens: reservedForOutput,
    };
  }

  return {
    isValid: true,
    inputTokens,
    contextLimit,
    maxTokens: reservedForOutput,
  };
}

/**
 * The output tokens of a response or attempt that reported no usage, from
 * what it streamed: the answer, the reasoning (signatures and encrypted
 * reasoning too, as countReasoningTokens counts them) and the tool calls'
 * names and arguments. Adjusted for the model like the prompt count, so both
 * sides of the price are estimated the same way.
 */
export function estimateOutputTokens(
  model: ModelConfig,
  response: {
    content: string;
    reasoning?: Reasoning;
    toolCalls: Iterable<Pick<ToolCall, "name" | "argumentsStr">>;
  },
): number {
  const calls = [...response.toolCalls].map((c) => c.name + c.argumentsStr);
  const tokens =
    countText([response.content, ...calls].join("\n")) +
    (response.reasoning ? countReasoningTokens(response.reasoning) : 0);
  return getAdjustedTokenCountFromModel(tokens, model.model ?? "");
}
