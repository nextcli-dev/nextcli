import { ModelConfig } from "@nextcli/config-yaml";
import { BaseLlmApi } from "@nextcli/openai-adapters";
import type { ChatHistoryItem, Reasoning } from "core/index.js";
import type { ChatCompletionTool } from "openai/resources.mjs";

import {
  describeFit,
  fitHistory,
  REQUEST_SAFETY_BUFFER,
} from "../fitHistory.js";
import type { ToolPermissionsSource } from "../permissions/types.js";
import { services } from "../services/index.js";
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
  estimateOutputTokens,
  historySentToModel,
  validateContextLength,
} from "../util/tokenizer.js";

import { AgentLoopLimitError } from "./agentLoopLimitError.js";
import {
  AgentLoopBudget,
  LimitWrapUp,
  wrapUpMessage,
} from "./agentLoopLimits.js";
import { handleToolCalls } from "./handleToolCalls.js";
import { ReasoningAccumulator } from "./reasoning.js";
import { trackStreamAttempts } from "./streamAttempts.js";
import { processChunk } from "./streamChatResponse.chunk.js";
import {
  handleNormalAutoCompaction,
  handlePostToolValidation,
  handlePreApiCompaction,
} from "./streamChatResponse.compactionHelpers.js";
import {
  addUserMessage,
  compiledRequest,
  estimateFinalCallCost,
  finalAnswerMaxTokens,
  recordFailedCall,
  recordStreamTelemetry,
  reportsUsage,
  trackFirstTokenTime,
  warnUnknownZeroPrice,
} from "./streamChatResponse.helpers.js";
import {
  getCompletionOptions,
  StreamCallbacks,
} from "./streamChatResponse.types.js";
import {
  type CallEnd,
  continueAfterResponse,
  endCall,
  readCallEnd,
  TurnState,
} from "./turnContinuation.js";
import { type Prefix, turnPrefix } from "./turnPrefix.js";

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

// Starts one model call. A run already past its turn, token or cost limit
// throws instead of calling; past its --max-time deadline it still makes the
// final call.
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
  /**
   * A summary request, already fitted by compactChatHistory. It is sent whole
   * or fails: fitting it again would keep the instruction as the newest turn
   * and drop the conversation.
   */
  isCompacting?: boolean;
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

  // Validate context length INCLUDING system message and tools
  const validate = (history: ChatHistoryItem[]) =>
    validateContextLength({
      chatHistory: history,
      model,
      safetyBuffer: REQUEST_SAFETY_BUFFER,
      systemMessage,
      tools,
    });

  // Too long for the window: fit this request only (the session keeps
  // everything)
  const sent = historySentToModel(options.chatHistory);
  const fitted = options.isCompacting
    ? { history: sent, removed: 0, shortened: 0 }
    : fitHistory(sent, (history) => validate(history).isValid);
  const chatHistory = fitted.history;
  const validation = validate(chatHistory);
  if ((fitted.removed > 0 || fitted.shortened > 0) && validation.isValid) {
    const notice = `Context window full: in this request, ${describeFit(fitted)}. The session keeps them in full.`;
    logger.warn(notice);
    callbacks?.onSystemMessage?.(notice);
  }

  if (!validation.isValid) {
    throw new Error(`Context length validation failed: ${validation.error}`);
  }

  const { context, messages: openaiChatHistory } = await compiledRequest({
    model,
    chatHistory,
    systemMessage,
    tools,
  });
  const requestStartTime = Date.now();

  const streamFactory = async (retryAbortSignal: AbortSignal) => {
    logger.debug("Creating chat completion stream", {
      model: model.model,
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
  let fullUsage: any = null;
  const reasoning = new ReasoningAccumulator();
  const attempts = trackStreamAttempts({
    requestStartTime,
    model,
    tools,
    context,
    abortSignal: abortController.signal,
    estimateInputTokens: () =>
      countTotalInputTokens({ chatHistory, systemMessage, tools, model }),
  });

  let callEnd: CallEnd = {};
  try {
    const streamWithBackoff = withExponentialBackoff(
      streamFactory,
      abortController.signal,
      undefined,
      attempts,
    );

    let chunkCount = 0;
    for await (const chunk of streamWithBackoff) {
      chunkCount++;
      callEnd = readCallEnd(callEnd, chunk);

      logger.trace("Received chunk", { chunkCount, chunk });

      // Track token usage if available
      if (reportsUsage(chunk.usage)) {
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
        { requestStartTime, arrivedAt: attempts.firstTokenAt() },
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

    const cost = recordStreamTelemetry({
      requestStartTime,
      responseEndTime: Date.now(),
      // Used only without a usage chunk: the request as its fit check
      // counted it and the streamed output, so the limits still see the call
      inputTokens: validation.inputTokens ?? 0,
      outputTokens: estimateOutputTokens(model, {
        content: aiResponse,
        reasoning: reasoning.result(),
        toolCalls: toolCallsMap.values(),
      }),
      model,
      tools,
      fullUsage,
      context,
      skipLastUsage: options.isCompacting,
      call: {
        finishReason: callEnd.finishReason,
        ttftMs: firstTokenTime ? firstTokenTime - requestStartTime : undefined,
        contentChars: aiResponse.length,
        reasoningChars: reasoning.chars(),
        toolCalls: [...toolCallsMap.values()].map((call) => call.name),
        aborted: abortController.signal.aborted || undefined,
      },
    });

    // Enhance fullUsage with model and cost for saving to session
    if (fullUsage) {
      fullUsage.model = model.model;
      fullUsage.cost_cents = Math.round(cost * 100); // Convert dollars to cents
    }
  } catch (error: any) {
    const aborted =
      error.name === "AbortError" || abortController?.signal.aborted;
    if (!attempts.recorded(error)) {
      recordFailedCall({ model, requestStartTime, error, aborted, context });
    }

    if (aborted) {
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
  } finally {
    endCall(callEnd);
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

export { requestTools } from "./turnPrefix.js";

// Main function that handles the conversation loop
// eslint-disable-next-line max-params
export async function streamChatResponse(
  chatHistory: ChatHistoryItem[],
  model: ModelConfig,
  llmApi: BaseLlmApi,
  abortController: AbortController,
  callbacks?: StreamCallbacks,
  isCompacting = false,
  /** The permissions this session's tools run with; the main session's by default */
  getPermissions?: ToolPermissionsSource,
  /** A compaction's: the turn's system message and tools, which it was fit to */
  given?: Prefix,
) {
  logger.debug("streamChatResponse called", {
    model: model.model,
    historyLength: chatHistory.length,
    hasCallbacks: !!callbacks,
  });

  const isHeadless = services.toolPermissions.isHeadless();
  warnUnknownZeroPrice(model, isHeadless, callbacks);

  let fullResponse = "";
  let finalResponse = "";
  const turn: TurnState = { askedForAnswer: false };

  // The final answer must still fit under --max-cost, with room to be written
  const budget = new AgentLoopBudget(
    () =>
      estimateFinalCallCost(
        model,
        countTotalInputTokens({ chatHistory, model }),
      ),
    !isCompacting,
  );

  const prefix = turnPrefix({ model, isHeadless, getPermissions, given });

  // Aborted on exit, so an interrupted turn never starts another tool (#12701)
  const unregisterAbort = registerAbortController(abortController);
  try {
    while (true) {
      // If ChatHistoryService is available, refresh local chatHistory view
      chatHistory = refreshChatHistoryFromService(chatHistory, isCompacting);
      logger.debug("Starting conversation iteration");

      // At a limit, the next call is the last one and has no tools. A run
      // already over its turn, token or cost limit throws instead of spending
      // another call; past its --max-time deadline it still makes the final one.
      let wrapUp: LimitWrapUp | undefined;
      ({ wrapUp, chatHistory } = applyTurnLimit(budget, chatHistory));

      // A run's last call and a compaction keep the turn's tools too, so
      // they read the conversation from the provider's cache
      const { systemMessage, tools } = await prefix();

      // A compaction is one call that only writes the summary: tool calls in
      // it, as in a run's last call, are dropped, never run. Run, the
      // summarizer went on reviewing in a nested loop that --max-turns and
      // --max-cost never saw (AI review run 43308492603).
      const onlyCall = !!wrapUp || isCompacting;

      // A compaction below leaves a history that ends with a user turn
      const compaction = {
        model,
        llmApi,
        isCompacting,
        isHeadless,
        callbacks,
        systemMessage,
        tools,
        abortController,
      };

      // Pre-API auto-compaction checkpoint (now includes tools). Not before
      // a run's last call: the limit left room for that call only, and the
      // request for the answer would go into the summary. processStreaming-
      // Response fits a history that is too long.
      if (!wrapUp) {
        chatHistory = (await handlePreApiCompaction(chatHistory, compaction))
          .chatHistory;
      }

      logger.debug("Tools prepared", {
        toolCount: tools.length,
        toolNames: tools.map((t) => t.function.name),
      });

      // Get response from LLM
      const respond = (callTools: ChatCompletionTool[], thinkingOff = false) =>
        budget.measure(() =>
          processStreamingResponse({
            isHeadless,
            chatHistory,
            model,
            llmApi,
            abortController,
            callbacks,
            tools: callTools,
            systemMessage,
            // The last call may only spend what is left under --max-cost
            maxTokens: wrapUp
              ? finalAnswerMaxTokens(
                  model,
                  budget.costLeft(),
                  countTotalInputTokens({ chatHistory, systemMessage, model }),
                )
              : undefined,
            thinkingOff,
            isCompacting,
          }),
        );
      let response = await respond(tools);
      // A last call or a summary must write text. One that answered only
      // with tool calls is asked once more as before the cache: no tools,
      // no tokens spent on thinking
      if (
        onlyCall &&
        !response.content.trim() &&
        !abortController.signal.aborted
      ) {
        response = await respond([], true);
      }
      const { content, toolCalls, shouldContinue, usage, reasoning } = response;

      if (abortController?.signal.aborted) {
        return finalResponse || content || fullResponse;
      }

      // Tool calls in it are dropped, not run
      if (isCompacting) {
        // A summary is stored by compactChatHistory's caller, after it passes
        // the next-request check; storing it here would write before that
        handleContentDisplay(content, callbacks, isHeadless);
        return content || finalResponse || fullResponse;
      }
      if (onlyCall) {
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
        getPermissions,
      });

      if (shouldReturn || abortController.signal.aborted) {
        return finalResponse || content || fullResponse;
      }

      // After tool execution, validate that we haven't exceeded context limit
      chatHistory = (
        await handlePostToolValidation(toolCalls, chatHistory, compaction)
      ).chatHistory;

      // Normal auto-compaction check at 80% threshold
      chatHistory = (
        await handleNormalAutoCompaction(
          chatHistory,
          shouldContinue,
          compaction,
        )
      ).chatHistory;

      // Stop unless tools ran or a missing answer is asked for
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
