import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem, Reasoning } from "core/index.js";
import { convertFromUnifiedHistoryWithSystemMessage } from "core/util/messageConversion.js";
import * as dotenv from "dotenv";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources.mjs";

import { pruneLastMessage } from "../compaction.js";
import { services } from "../services/index.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import { applyChatCompletionToolOverrides } from "../tools/applyToolOverrides.js";
import { ToolCall } from "../tools/index.js";
import { registerAbortController } from "../util/abortRegistry.js";
import {
  chatCompletionStreamWithBackoff,
  isContextLengthError,
  withExponentialBackoff,
} from "../util/exponentialBackoff.js";
import { logger } from "../util/logger.js";
import {
  countTotalInputTokens,
  validateContextLength,
} from "../util/tokenizer.js";

import { AgentLoopLimitError } from "./agentLoopLimitError.js";
import {
  AgentLoopBudget,
  LimitWrapUp,
  wrapUpMessage,
} from "./agentLoopLimits.js";
import { getRequestTools, handleToolCalls } from "./handleToolCalls.js";
import { ReasoningAccumulator } from "./reasoning.js";
import { processChunk } from "./streamChatResponse.chunk.js";
import {
  handleNormalAutoCompaction,
  handlePostToolValidation,
  handlePreApiCompaction,
} from "./streamChatResponse.compactionHelpers.js";
import {
  addUserMessage,
  estimateFinalCallCost,
  finalAnswerMaxTokens,
  recordStreamTelemetry,
  trackFirstTokenTime,
} from "./streamChatResponse.helpers.js";
import {
  getCompletionOptions,
  StreamCallbacks,
} from "./streamChatResponse.types.js";
import {
  continueAfterResponse,
  recordCallEnd,
  resetCallEnd,
  TurnState,
} from "./turnContinuation.js";

dotenv.config();

function updateFinalResponse(
  content: string,
  shouldContinue: boolean,
  isHeadless: boolean,
  currentFinalResponse: string,
): string {
  if (!shouldContinue) {
    return content;
  } else if (isHeadless && content) {
    return content;
  }
  return currentFinalResponse;
}

function handleContentDisplay(
  content: string,
  callbacks: StreamCallbacks | undefined,
  isHeadless: boolean,
): void {
  // Add newline after content if needed
  if (!callbacks?.onContent && !isHeadless && content) {
    logger.info("");
  }

  // Notify content complete
  if (content && callbacks?.onContentComplete) {
    callbacks.onContentComplete(content);
  }
}

// Helper function to refresh chat history from service
function refreshChatHistoryFromService(
  chatHistory: ChatHistoryItem[],
  isCompacting: boolean,
): ChatHistoryItem[] {
  const chatHistorySvc = services.chatHistory;
  if (
    typeof chatHistorySvc?.isReady === "function" &&
    chatHistorySvc.isReady()
  ) {
    try {
      // use chat history from params when isCompacting is true
      // otherwise use the full history
      if (!isCompacting) {
        return chatHistorySvc.getHistory();
      }
    } catch {}
  }
  return chatHistory;
}

// Starts one model call. A run already past its limit throws instead of calling.
function applyTurnLimit(
  budget: AgentLoopBudget,
  chatHistory: ChatHistoryItem[],
): { wrapUp: LimitWrapUp | undefined; chatHistory: ChatHistoryItem[] } {
  const wrapUp = budget.nextTurn();
  if (wrapUp?.stop) {
    throw new AgentLoopLimitError(wrapUp);
  }
  return {
    wrapUp,
    chatHistory: wrapUp
      ? addUserMessage(chatHistory, wrapUpMessage(wrapUp))
      : chatHistory,
  };
}

// Shows and stores the answer of a run's last call. Tool calls in it are
// dropped, not run.
async function saveFinalAnswer(
  options: Omit<Parameters<typeof handleToolCalls>[0], "toolCalls">,
): Promise<void> {
  handleContentDisplay(options.content, options.callbacks, options.isHeadless);
  await handleToolCalls({ ...options, toolCalls: [] });
}

interface ProcessStreamingResponseOptions {
  chatHistory: ChatHistoryItem[];
  model: ModelConfig;
  llmApi: BaseLlmApi;
  abortController: AbortController;
  callbacks?: StreamCallbacks;
  isHeadless?: boolean;
  tools?: ChatCompletionTool[];
  systemMessage: string;
  /** Overrides the model's max_tokens for this call */
  maxTokens?: number;
  /** Turns thinking off for this call, for a model that can */
  thinkingOff?: boolean;
}

// Process a single streaming response and return whether we need to continue
// eslint-disable-next-line max-statements
export async function processStreamingResponse(
  options: ProcessStreamingResponseOptions,
): Promise<{
  content: string;
  finalContent: string; // Added field for final content only
  toolCalls: ToolCall[];
  shouldContinue: boolean;
  usage?: any;
  reasoning?: Reasoning;
}> {
  const {
    model,
    llmApi,
    abortController,
    callbacks,
    isHeadless,
    tools,
    systemMessage,
  } = options;

  let chatHistory = options.chatHistory;

  // Safety buffer to account for tokenization estimation errors
  const SAFETY_BUFFER = 100;

  // Validate context length INCLUDING system message and tools
  let validation = validateContextLength({
    chatHistory,
    model,
    safetyBuffer: SAFETY_BUFFER,
    systemMessage,
    tools,
  });

  // Prune last messages until valid (excluding system message)
  while (chatHistory.length > 1 && !validation.isValid) {
    const prunedChatHistory = pruneLastMessage(chatHistory);
    if (prunedChatHistory.length === chatHistory.length) {
      break;
    }
    chatHistory = prunedChatHistory;

    // Re-validate with system message and tools
    validation = validateContextLength({
      chatHistory,
      model,
      safetyBuffer: SAFETY_BUFFER,
      systemMessage,
      tools,
    });
  }

  if (!validation.isValid) {
    throw new Error(`Context length validation failed: ${validation.error}`);
  }

  // Create OpenAI format history with validated system message
  const openaiChatHistory = convertFromUnifiedHistoryWithSystemMessage(
    chatHistory,
    systemMessage,
    { model: model.model },
  ) as ChatCompletionMessageParam[];
  const requestStartTime = Date.now();

  const streamFactory = async (retryAbortSignal: AbortSignal) => {
    logger.debug("Creating chat completion stream", {
      model,
      messageCount: chatHistory.length,
      toolCount: tools?.length || 0,
    });
    return await chatCompletionStreamWithBackoff(
      llmApi,
      {
        model: model.model,
        messages: openaiChatHistory,
        stream: true,
        // OpenAI rejects an empty tools array, so send none at all
        tools: tools?.length ? tools : undefined,
        ...getCompletionOptions(model, { thinkingOff: options.thinkingOff }),
        ...(options.maxTokens !== undefined && {
          max_tokens: options.maxTokens,
        }),
      },
      retryAbortSignal,
    );
  };

  let aiResponse = "";
  let finalContent = "";
  const toolCallsMap = new Map<string, ToolCall>();
  const indexToIdMap = new Map<number, string>(); // Track index to ID mapping
  let firstTokenTime: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let fullUsage: any = null;
  const reasoning = new ReasoningAccumulator();

  try {
    const streamWithBackoff = withExponentialBackoff(
      streamFactory,
      abortController.signal,
    );

    let chunkCount = 0;
    resetCallEnd();
    for await (const chunk of streamWithBackoff) {
      chunkCount++;
      recordCallEnd(chunk);

      logger.debug("Received chunk", { chunkCount, chunk });

      // Track token usage if available
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
        fullUsage = chunk.usage; // Capture full usage including cache details
      }

      // Check if we should abort
      if (abortController?.signal.aborted) {
        logger.debug("Stream aborted");
        break;
      }

      // Track first token time
      firstTokenTime = trackFirstTokenTime(
        firstTokenTime,
        chunk,
        requestStartTime,
        model,
        tools,
      );

      const result = processChunk({
        chunk,
        aiResponse,
        toolCallsMap,
        indexToIdMap,
        callbacks,
        isHeadless,
        reasoning,
      });
      aiResponse = result.aiResponse;
      if (!result.shouldContinue) break;
    }

    const responseEndTime = Date.now();
    const cost = recordStreamTelemetry({
      requestStartTime,
      responseEndTime,
      inputTokens,
      outputTokens,
      model,
      tools,
      fullUsage,
    });
    const totalDuration = responseEndTime - requestStartTime;

    // Enhance fullUsage with model and cost for saving to session
    if (fullUsage) {
      fullUsage.model = model.model;
      fullUsage.cost_cents = Math.round(cost * 100); // Convert dollars to cents
    }

    logger.debug("Stream complete", {
      chunkCount,
      responseLength: aiResponse.length,
      toolCallsCount: toolCallsMap.size,
      inputTokens,
      outputTokens,
      cacheReadTokens: fullUsage?.prompt_tokens_details?.cache_read_tokens,
      cacheWriteTokens: fullUsage?.prompt_tokens_details?.cache_write_tokens,
      cost,
      duration: totalDuration,
    });
  } catch (error: any) {
    const errorDuration = Date.now() - requestStartTime;

    // Log failed API request
    telemetryService.logApiRequest({
      model: model.model,
      durationMs: errorDuration,
      success: false,
      error: error.message || String(error),
    });

    if (error.name === "AbortError" || abortController?.signal.aborted) {
      logger.debug("Stream aborted by user");
      return {
        content: aiResponse,
        finalContent: aiResponse,
        toolCalls: [],
        shouldContinue: false,
        usage: fullUsage,
        reasoning: reasoning.result(),
      };
    }

    // Handle context length errors with helpful message
    if (isContextLengthError(error)) {
      logger.debug(`Context length exceeded: ${error}`);
      throw new Error(`Context length exceeded: ${error}`);
    }

    throw error;
  }

  const toolCalls = Array.from(toolCallsMap.values());

  // Validate tool calls have complete arguments
  const validToolCalls = toolCalls.filter((tc) => {
    if (!tc.name) {
      logger.error("Incomplete tool call", {
        id: tc.id,
        name: tc.name,
        hasArguments: !!tc.arguments,
        argumentsStr: tc.argumentsStr,
      });
      return false;
    }
    return true;
  });

  // Always preserve the content - it should be displayed regardless of tool calls
  finalContent = aiResponse;

  return {
    content: aiResponse,
    finalContent: finalContent,
    toolCalls: validToolCalls,
    shouldContinue: validToolCalls.length > 0,
    usage: fullUsage,
    reasoning: reasoning.result(),
  };
}

// Main function that handles the conversation loop
// eslint-disable-next-line max-params
export async function streamChatResponse(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  abortController: AbortController,
  callbacks?: StreamCallbacks,
  isCompacting = false,
) {
  logger.debug("streamChatResponse called", {
    model,
    historyLength: chatHistory.length,
    hasCallbacks: !!callbacks,
  });

  const isHeadless = services.toolPermissions.isHeadless();

  let fullResponse = "";
  let finalResponse = "";
  const turn: TurnState = { compacted: false, askedForAnswer: false };

  // The final answer must still fit under --max-cost, with room to be written
  const budget = new AgentLoopBudget(() =>
    estimateFinalCallCost(model, countTotalInputTokens({ chatHistory, model })),
  );

  // Aborted on exit, so an interrupted turn never starts another tool (#12701)
  const unregisterAbort = registerAbortController(abortController);
  try {
    while (true) {
      // If ChatHistoryService is available, refresh local chatHistory view
      chatHistory = refreshChatHistoryFromService(chatHistory, isCompacting);
      logger.debug("Starting conversation iteration");

      // At a limit, the next call is the last one and has no tools. A run
      // already over the limit throws instead of spending another call.
      let wrapUp: LimitWrapUp | undefined;
      ({ wrapUp, chatHistory } = applyTurnLimit(budget, chatHistory));

      // Get system message once per iteration (can change based on tool permissions mode)
      const systemMessage = await services.systemMessage.getSystemMessage(
        services.toolPermissions.getState().currentMode,
      );

      // Recompute tools on each iteration to handle mode changes during
      // streaming. A run's last call gets none.
      const tools = applyChatCompletionToolOverrides(
        wrapUp ? [] : await getRequestTools(isHeadless),
        model.chatOptions?.toolOverrides,
      );

      // Pre-API auto-compaction checkpoint (now includes tools)
      const preCompactionResult = await handlePreApiCompaction(chatHistory, {
        model,
        llmApi,
        isCompacting,
        isHeadless,
        callbacks,
        systemMessage,
        tools,
      });
      chatHistory = preCompactionResult.chatHistory;
      if (preCompactionResult.wasCompacted) {
        turn.compacted = true;
      }

      logger.debug("Tools prepared", {
        toolCount: tools.length,
        toolNames: tools.map((t) => t.function.name),
      });

      // Get response from LLM
      const { content, toolCalls, shouldContinue, usage, reasoning } =
        await budget.measure(() =>
          processStreamingResponse({
            isHeadless,
            chatHistory,
            model,
            llmApi,
            abortController,
            callbacks,
            tools,
            systemMessage,
            // The last call may only spend what is left under --max-cost
            maxTokens: wrapUp
              ? finalAnswerMaxTokens(
                  model,
                  budget.costLeft(),
                  countTotalInputTokens({ chatHistory, systemMessage, model }),
                )
              : undefined,
            // The last call writes the answer: no tokens spent on thinking
            thinkingOff: !!wrapUp,
          }),
        );

      if (abortController?.signal.aborted) {
        return finalResponse || content || fullResponse;
      }

      if (wrapUp) {
        await saveFinalAnswer({
          chatHistory,
          content,
          callbacks,
          isHeadless,
          usage,
          reasoning,
          signal: abortController.signal,
        });
        return content || finalResponse || fullResponse;
      }

      fullResponse += content;

      // Update final response based on mode
      finalResponse = updateFinalResponse(
        content,
        shouldContinue,
        isHeadless,
        finalResponse,
      );

      // Handle content display
      handleContentDisplay(content, callbacks, isHeadless);

      // Handle tool calls and check for early return. This updates history via ChatHistoryService.
      const shouldReturn = await handleToolCalls({
        toolCalls,
        chatHistory,
        content,
        callbacks,
        isHeadless,
        usage,
        reasoning,
        signal: abortController.signal,
      });

      if (shouldReturn || abortController.signal.aborted) {
        return finalResponse || content || fullResponse;
      }

      // After tool execution, validate that we haven't exceeded context limit
      const postToolResult = await handlePostToolValidation(
        toolCalls,
        chatHistory,
        {
          model,
          llmApi,
          isCompacting,
          isHeadless,
          callbacks,
          systemMessage,
          tools,
        },
      );
      chatHistory = postToolResult.chatHistory;
      if (postToolResult.wasCompacted) {
        turn.compacted = true;
      }

      // Normal auto-compaction check at 80% threshold
      const compactionResult = await handleNormalAutoCompaction(
        chatHistory,
        shouldContinue,
        {
          model,
          llmApi,
          isCompacting,
          isHeadless,
          callbacks,
          systemMessage,
          tools,
        },
      );
      chatHistory = compactionResult.chatHistory;
      if (compactionResult.wasCompacted) {
        turn.compacted = true;
      }

      // Stop unless tools ran, compaction ran, or a missing answer is asked for
      const next = continueAfterResponse(turn, {
        shouldContinue,
        content,
        chatHistory,
      });
      chatHistory = next.chatHistory;
      if (!next.continue) {
        break;
      }
    }

    logger.debug("streamChatResponse complete", {
      totalResponseLength: fullResponse.length,
      totalMessages: chatHistory.length,
    });

    // For headless mode, we return only the final response
    // Otherwise, return the full response
    return isHeadless ? finalResponse : fullResponse;
  } finally {
    unregisterAbort();
  }
}
