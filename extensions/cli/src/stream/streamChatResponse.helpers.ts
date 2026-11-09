// Helper functions extracted from streamChatResponse.ts to reduce file size
/* eslint-disable max-lines */

import type { ChatHistoryItem, ToolStatus, Usage } from "core/index.js";
import { calculateRequestCost } from "core/llm/utils/calculateRequestCost.js";
import { ContinueError, ContinueErrorReason } from "core/util/errors.js";
import { ChatCompletionToolMessageParam } from "openai/resources/chat/completions.mjs";

import { ToolPermissionServiceState } from "src/services/ToolPermissionService.js";

import { checkToolPermission } from "../permissions/permissionChecker.js";
import { toolPermissionManager } from "../permissions/permissionManager.js";
import {
  ToolCallRequest,
  ToolPermissions,
  ToolPermissionsSource,
} from "../permissions/types.js";
import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import { trackSessionUsage } from "../session.js";
import { telemetryService } from "../telemetry/telemetryService.js";
import {
  executeToolCall,
  getAllAvailableTools,
  Tool,
  validateToolCallArgsPresent,
} from "../tools/index.js";
import { ToolInterruptedError } from "../tools/toolInterruptedError.js";
import { PreprocessedToolCall, ToolCall } from "../tools/types.js";
import { traceEvent } from "../trace/trace.js";
import { logger } from "../util/logger.js";
import { getModelMaxTokens } from "../util/tokenizer.js";
import {
  parseEnvNumber,
  truncateByLinesAndChars,
} from "../util/truncateOutput.js";

import { type PriceSource, recordPriceSource } from "./agentLoopLimits.js";
import { StreamCallbacks } from "./streamChatResponse.types.js";

export interface ToolResultWithStatus extends ChatCompletionToolMessageParam {
  status: ToolStatus;
}

// Helper function to handle permission denied
export function handlePermissionDenied(
  toolCall: PreprocessedToolCall,
  chatHistoryEntries: ChatCompletionToolMessageParam[],
  callbacks?: StreamCallbacks,
  reason: "user" | "policy" = "user",
): void {
  const deniedMessage =
    reason === "policy"
      ? `Command blocked by security policy`
      : `Permission denied by user`;

  logger.info("Tool call denied", {
    name: toolCall.name,
    arguments: toolCall.arguments,
    reason,
  });

  chatHistoryEntries.push({
    role: "tool",
    tool_call_id: toolCall.id,
    content: deniedMessage,
  });

  callbacks?.onToolResult?.(deniedMessage, toolCall.name, "canceled");
  logger.debug(`Tool call rejected (${reason}) - stopping stream`);
}

// Helper function to request user permission
export async function requestUserPermission(
  toolCall: PreprocessedToolCall,
  callbacks?: StreamCallbacks,
): Promise<boolean> {
  if (!callbacks?.onToolPermissionRequest) {
    return false;
  }

  const toolCallRequest: ToolCallRequest = {
    name: toolCall.name,
    arguments: toolCall.preprocessResult?.args ?? toolCall.arguments,
    preview: toolCall.preprocessResult?.preview,
  };

  // Set up listener for permissionRequested event
  const handlePermissionRequested = (event: {
    requestId: string;
    toolCall: ToolCallRequest;
  }) => {
    if (event.toolCall.name === toolCall.name) {
      toolPermissionManager.off(
        "permissionRequested",
        handlePermissionRequested,
      );
      // Notify UI about permission request
      callbacks.onToolPermissionRequest!(
        event.toolCall.name,
        event.toolCall.arguments,
        event.requestId,
        event.toolCall.preview,
      );
    }
  };

  toolPermissionManager.on("permissionRequested", handlePermissionRequested);

  // Request permission using the proper API
  const permissionResult =
    await toolPermissionManager.requestPermission(toolCallRequest);

  // Clean up listener in case the condition above was never met
  // This is a safety net to ensure no listeners are left behind
  toolPermissionManager.off("permissionRequested", handlePermissionRequested);

  return permissionResult.approved;
}

/** The main session's tool permissions */
export const readSessionPermissions: ToolPermissionsSource = async () => {
  const state = await serviceContainer.get<ToolPermissionServiceState>(
    SERVICE_NAMES.TOOL_PERMISSIONS,
  );
  return state.permissions;
};

// Helper function to check if tool permission is needed
export async function checkToolPermissionApproval(
  permissions: ToolPermissions,
  toolCall: PreprocessedToolCall,
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
): Promise<{ approved: boolean; denialReason?: "user" | "policy" }> {
  const permissionCheck = checkToolPermission(toolCall, permissions);

  if (permissionCheck.permission === "allow") {
    return { approved: true };
  } else if (permissionCheck.permission === "ask") {
    if (isHeadless) {
      // "ask" tools are excluded in headless so can only get here by policy evaluation
      return { approved: false, denialReason: "policy" };
    }
    const userApproved = await requestUserPermission(toolCall, callbacks);
    return userApproved
      ? { approved: true }
      : { approved: false, denialReason: "user" };
  } else if (permissionCheck.permission === "exclude") {
    // Tool blocked by security policy
    return { approved: false, denialReason: "policy" };
  }

  return { approved: false, denialReason: "policy" };
}

/** A chunk with anything the model generated: answer, tool call or reasoning */
export function hasGeneratedToken(chunk: any): boolean {
  const delta = chunk.choices?.[0]?.delta;
  return !!(
    delta &&
    (delta.content ||
      delta.tool_calls ||
      (typeof delta.reasoning_content === "string" &&
        delta.reasoning_content) ||
      (typeof delta.reasoning === "string" && delta.reasoning) ||
      delta.reasoning_details?.length)
  );
}

/**
 * The provider's error for a trace or log line: its first line, at most 200
 * characters, since some providers echo the request in the message.
 */
export function describeError(error: any): { error: string; status?: number } {
  const message = String(error?.message || error).split("\n")[0];
  return {
    error: message.slice(0, 200),
    ...(typeof error?.status === "number" && { status: error.status }),
  };
}

// Helper function to track first token time
export function trackFirstTokenTime(
  firstTokenTime: number | null,
  chunk: any,
  timing: {
    requestStartTime: number;
    /** When the token arrived, if it was held before being yielded */
    arrivedAt?: number;
  },
  model: any,
  tools?: any[],
): number | null {
  if (firstTokenTime === null && hasGeneratedToken(chunk)) {
    const tokenTime = timing.arrivedAt ?? Date.now();
    telemetryService.recordResponseTime(
      tokenTime - timing.requestStartTime,
      model.model,
      "time_to_first_token",
      (tools?.length || 0) > 0,
    );
    return tokenTime;
  }
  return firstTokenTime;
}

// Helper function to process content from a chunk
export function processChunkContent(
  content: string,
  aiResponse: string,
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
): string {
  const updatedResponse = aiResponse + content;

  if (callbacks?.onContent) {
    callbacks.onContent(content);
  } else if (!isHeadless) {
    process.stdout.write(content);
  }

  return updatedResponse;
}

// Every tool result passes through this cap before it reaches the model, so a
// tool without its own limit (MCP servers, errors with full stderr) cannot
// flood the context (#12700). Tools with tighter limits stay below it.
const DEFAULT_TOOL_RESULT_MAX_CHARS = 100_000;
const DEFAULT_TOOL_RESULT_MAX_LINES = 4000;

export function capToolResult(result: string): string {
  return truncateByLinesAndChars(
    result,
    parseEnvNumber(
      process.env.CONTINUE_CLI_TOOL_RESULT_MAX_LINES,
      DEFAULT_TOOL_RESULT_MAX_LINES,
    ),
    parseEnvNumber(
      process.env.CONTINUE_CLI_TOOL_RESULT_MAX_CHARS,
      DEFAULT_TOOL_RESULT_MAX_CHARS,
    ),
    "tool output",
  ).output;
}

function isCompleteJson(text: string): boolean {
  if (!text) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Helper function to handle tool call delta
export function processToolCallDelta(
  toolCallDelta: any,
  toolCallsMap: Map<string, ToolCall>,
  indexToIdMap: Map<number, string>,
): void {
  let toolCallId: string | undefined;

  // If we have an ID, use it and map the index
  if (toolCallDelta.id) {
    toolCallId = toolCallDelta.id;
    if (toolCallDelta.index !== undefined && toolCallId) {
      indexToIdMap.set(toolCallDelta.index, toolCallId);
    }
  } else if (toolCallDelta.index !== undefined) {
    // No ID, but we have an index - look up the ID from our map
    toolCallId = indexToIdMap.get(toolCallDelta.index);
  }

  if (!toolCallId) {
    logger.warn("Tool call delta without ID or valid index mapping", {
      toolCallDelta,
    });
    return;
  }

  // A named delta for an id whose call is already complete is a second call
  // reusing the id (#12626). Some providers always send index 0, so the index
  // can't tell them apart. Store it under a new key; handleToolCalls gives it
  // a fresh id.
  const existing = toolCallsMap.get(toolCallId);
  if (
    existing &&
    toolCallDelta.function?.name &&
    existing.name &&
    isCompleteJson(existing.argumentsStr)
  ) {
    let suffix = 1;
    while (toolCallsMap.has(`${toolCallId}#${suffix}`)) suffix++;
    const newKey = `${toolCallId}#${suffix}`;
    toolCallsMap.set(newKey, {
      id: toolCallId,
      name: "",
      arguments: {},
      argumentsStr: "",
      startNotified: false,
    });
    if (toolCallDelta.index !== undefined) {
      indexToIdMap.set(toolCallDelta.index, newKey);
    }
    toolCallId = newKey;
  } else if (toolCallDelta.id && toolCallsMap.has(`${toolCallId}#1`)) {
    // Later deltas for a reused id belong to the newest call with that id
    let suffix = 1;
    while (toolCallsMap.has(`${toolCallId}#${suffix + 1}`)) suffix++;
    toolCallId = `${toolCallId}#${suffix}`;
  }

  // Create tool call entry if it doesn't exist
  if (!toolCallsMap.has(toolCallId)) {
    toolCallsMap.set(toolCallId, {
      id: toolCallId,
      name: "",
      arguments: {},
      argumentsStr: "",
      startNotified: false,
    });
  }

  const toolCall = toolCallsMap.get(toolCallId);
  if (!toolCall) {
    logger.warn("Tool call not found in map", { toolCallId });
    return;
  }

  // Update name
  if (toolCallDelta.function?.name) {
    toolCall.name = toolCallDelta.function.name;
  }

  // Accumulate arguments
  if (toolCallDelta.function?.arguments) {
    toolCall.argumentsStr += toolCallDelta.function.arguments;

    // Try to parse when we might have complete JSON
    try {
      toolCall.arguments = JSON.parse(toolCall.argumentsStr);
      toolCall.startNotified = true;
    } catch {
      // JSON not complete yet, continue
    }
  }

  // Capture extra_content
  if (toolCallDelta.extra_content) {
    toolCall.extra_content = toolCallDelta.extra_content;
  }
}

// Providers that run models on the user's machine, where calls cost nothing
const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llamafile",
  "llama.cpp",
  "llamacpp",
  "msty",
]);

// Providers whose own price tables calculateRequestCost knows
const PRICED_PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);

// Helper function to detect provider from model name
function detectProvider(modelName: string): string {
  const normalized = modelName.toLowerCase();
  if (normalized.includes("gpt") || normalized.includes("openai")) {
    return "openai";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  // Default to anthropic for backward compatibility
  return "anthropic";
}

// Simple fallback cost calculation for unknown models
function calculateFallbackCost(
  inputTokens: number,
  outputTokens: number,
): number {
  // Default pricing: $1/MTok input, $2/MTok output
  return (inputTokens * 1 + outputTokens * 2) / 1_000_000;
}

/** Prices one request the same way the run's cost is tracked */
export function priceRequest(
  model: any,
  usage: Usage,
): { cost: number; priced: PriceSource } {
  const configuredProvider = String(model.provider ?? "").toLowerCase();
  const provider = PRICED_PROVIDERS.has(configuredProvider)
    ? configuredProvider
    : detectProvider(model.model);
  const costBreakdown = calculateRequestCost(provider, model.model, usage, {
    apiBase: model.apiBase,
    estimateUnknown: !LOCAL_PROVIDERS.has(configuredProvider),
  });
  if (costBreakdown) {
    return {
      cost: costBreakdown.cost,
      priced: costBreakdown.priced ?? "exact",
    };
  }
  return {
    cost: calculateFallbackCost(usage.promptTokens, usage.completionTokens),
    priced: "fallback",
  };
}

/** Output tokens kept for the final answer, reasoning included */
export const FINAL_ANSWER_TOKENS = 16_000;

/** A roomy final answer, used only when the money left covers it */
export const MIN_FINAL_ANSWER_TOKENS = 4096;

/** The shortest final answer, so a nearly exhausted budget can still reply */
export const SHORT_FINAL_ANSWER_TOKENS = 256;

/**
 * The output a final answer is always given under --max-cost: room to think
 * (a model with a thinking budget spends tokens on that first) and to write
 */
export function guaranteedFinalAnswerTokens(model: any): number {
  const thinkingBudget = model.defaultCompletionOptions?.reasoningBudgetTokens;
  return Math.max(
    MIN_FINAL_ANSWER_TOKENS,
    typeof thinkingBudget === "number" ? thinkingBudget + 1024 : 0,
  );
}

/**
 * How much bigger the prompt of the final call may be than the history now.
 * The call before it adds its tool results, which can be several files.
 */
export const FINAL_PROMPT_GROWTH = 1.25;

/**
 * What the final call of a run would cost if it were made after one more
 * model call: a bigger prompt, and the most output a final answer can use.
 * This is what --max-cost keeps in reserve. A reasoning model thinks before it
 * writes, and a final answer that runs out of tokens while thinking is empty,
 * so the reserve is for a full-size answer, not the smallest one.
 */
export function estimateFinalCallCost(
  model: any,
  historyTokens: number,
): number {
  return estimateFinalAnswerCost(
    model,
    Math.ceil(historyTokens * FINAL_PROMPT_GROWTH),
  );
}

/**
 * What a final answer to this prompt would cost.
 * By default it counts the most output a final answer can use.
 */
export function estimateFinalAnswerCost(
  model: any,
  promptTokens: number,
  outputTokens = FINAL_ANSWER_TOKENS,
): number {
  return priceRequest(model, {
    promptTokens,
    completionTokens: Math.min(outputTokens, getModelMaxTokens(model)),
  }).cost;
}

/**
 * Output tokens the last call of a run may use so the run stays within
 * --max-cost: what the money left buys after the prompt. A short floor still
 * leaves room for an answer when almost nothing is left. The larger floor
 * applies only when the budget covers it. Undefined when there is no cost limit.
 */
export function finalAnswerMaxTokens(
  model: any,
  costLeft: number | undefined,
  promptTokens: number,
): number | undefined {
  if (costLeft === undefined) {
    return undefined;
  }
  const promptCost = priceRequest(model, {
    promptTokens,
    completionTokens: 0,
  }).cost;
  const outputCostPerToken =
    priceRequest(model, { promptTokens: 0, completionTokens: 1_000_000 }).cost /
    1_000_000;
  const affordable =
    outputCostPerToken > 0
      ? Math.floor(Math.max(0, costLeft - promptCost) / outputCostPerToken)
      : Infinity;
  const roomyFloor = guaranteedFinalAnswerTokens(model);
  const floor =
    affordable >= roomyFloor ? roomyFloor : SHORT_FINAL_ANSWER_TOKENS;
  return Math.min(
    getModelMaxTokens(model),
    FINAL_ANSWER_TOKENS,
    Math.max(floor, affordable),
  );
}

// Helper function to record telemetry
export function recordStreamTelemetry(options: {
  requestStartTime: number;
  responseEndTime: number;
  inputTokens: number;
  outputTokens: number;
  model: any;
  tools?: any[];
  fullUsage?: any;
  /** What only the caller knows, for the "Model call" log line and trace */
  call: {
    finishReason?: string;
    ttftMs?: number;
    contentChars?: number;
    reasoningChars?: number;
    toolCalls?: string[];
    /** An attempt that failed partway and was not used */
    discarded?: boolean;
    /** The user stopped the call */
    aborted?: boolean;
    /** Why the attempt failed, from describeError */
    error?: string;
    status?: number;
  };
}): number {
  const {
    requestStartTime,
    responseEndTime,
    inputTokens,
    outputTokens,
    model,
    tools,
    fullUsage,
  } = options;
  const totalDuration = responseEndTime - requestStartTime;

  // Calculate cost using comprehensive pricing that includes caching
  let cost: number;
  let priced: PriceSource;
  let usage: Usage;

  if (fullUsage) {
    // Transform API usage format to Usage interface
    usage = {
      promptTokens: fullUsage.prompt_tokens,
      completionTokens: fullUsage.completion_tokens,
      promptTokensDetails: fullUsage.prompt_tokens_details
        ? {
            cachedTokens: fullUsage.prompt_tokens_details.cache_read_tokens,
            cacheWriteTokens:
              fullUsage.prompt_tokens_details.cache_write_tokens,
          }
        : undefined,
    };

    ({ cost, priced } = priceRequest(model, usage));
  } else {
    // Fallback when fullUsage not available
    usage = {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
    };
    cost = calculateFallbackCost(inputTokens, outputTokens);
    priced = "fallback";
  }
  recordPriceSource(priced);

  // Use tokens from fullUsage if available, otherwise use the passed params
  const actualInputTokens = fullUsage?.prompt_tokens ?? inputTokens;
  const actualOutputTokens = fullUsage?.completion_tokens ?? outputTokens;

  telemetryService.recordTokenUsage(actualInputTokens, "input", model.model);
  telemetryService.recordTokenUsage(actualOutputTokens, "output", model.model);

  // Record cache tokens if available
  if (fullUsage?.prompt_tokens_details?.cache_read_tokens) {
    telemetryService.recordTokenUsage(
      fullUsage.prompt_tokens_details.cache_read_tokens,
      "cacheRead",
      model.model,
    );
  }
  if (fullUsage?.prompt_tokens_details?.cache_write_tokens) {
    telemetryService.recordTokenUsage(
      fullUsage.prompt_tokens_details.cache_write_tokens,
      "cacheCreation",
      model.model,
    );
  }

  telemetryService.recordCost(cost, model.model);
  trackSessionUsage(cost, usage);

  telemetryService.recordResponseTime(
    totalDuration,
    model.model,
    "total_response_time",
    (tools?.length || 0) > 0,
  );

  telemetryService.logApiRequest({
    model: model.model,
    durationMs: totalDuration,
    success: !options.call.error,
    inputTokens: actualInputTokens,
    outputTokens: actualOutputTokens,
    costUsd: cost,
  });

  const attrs = {
    model: model.model,
    // As the provider sent it, so its cache fields show as they are
    usage: fullUsage ?? {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      estimated: true,
    },
    costUsd: cost,
    priced,
    ...options.call,
  };
  writeCallRecord(attrs, { ts: requestStartTime, dur: totalDuration });

  return cost;
}

/** One record per model call attempt: a cn.log line at verbose, and the trace */
function writeCallRecord(
  attrs: Record<string, unknown>,
  timing: { ts: number; dur: number },
): void {
  // The log line would print an unset field as "[undefined]"
  const set = Object.fromEntries(
    Object.entries(attrs).filter(([, value]) => value !== undefined),
  );
  logger.verbose("Model call", { ...set, durationMs: timing.dur });
  traceEvent("llm.request", set, timing);
}

/**
 * Records a model call that threw before any chunk: the provider failed, or
 * the user aborted. An attempt that had chunks is recorded as discarded.
 */
export function recordFailedCall(options: {
  model: any;
  requestStartTime: number;
  error: any;
  aborted: boolean;
}): void {
  const { model, requestStartTime, aborted } = options;
  const durationMs = Date.now() - requestStartTime;
  const failure = describeError(options.error);
  telemetryService.logApiRequest({
    model: model.model,
    durationMs,
    success: false,
    error: failure.error,
  });
  writeCallRecord(
    { model: model.model, ...failure, aborted },
    { ts: requestStartTime, dur: durationMs },
  );
}

/**
 * Processes tool calls by validating and preprocessing them
 * @param toolCalls - The raw tool calls from the LLM
 * @param callbacks - Optional callbacks for notifying of events
 * @returns - Preprocessed tool calls that are ready for execution
 */
export async function preprocessStreamedToolCalls(
  isHeadless: boolean,
  toolCalls: ToolCall[],
  callbacks?: StreamCallbacks,
): Promise<{
  preprocessedCalls: PreprocessedToolCall[];
  errorChatEntries: ChatCompletionToolMessageParam[];
}> {
  const preprocessedCalls: PreprocessedToolCall[] = [];
  const errorChatEntries: ChatCompletionToolMessageParam[] = [];

  // Get all available tools

  // Process each tool call
  for (const toolCall of toolCalls) {
    const startTime = Date.now();
    try {
      const availableTools: Tool[] = await getAllAvailableTools(isHeadless);
      const tool = availableTools.find((t) => t.name === toolCall.name);
      if (!tool) {
        throw new Error(`Tool ${toolCall.name} not found`);
      }

      validateToolCallArgsPresent(toolCall, tool);

      const preprocessedCall: PreprocessedToolCall = {
        ...toolCall,
        tool,
      };

      if (tool.preprocess) {
        logger.debug("Preprocessing tool call args", {
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
        const preprocessed = await tool.preprocess(toolCall.arguments);
        preprocessedCall.preprocessResult = preprocessed;
      }

      preprocessedCalls.push(preprocessedCall);
    } catch (error) {
      // Notify the UI about the tool start, even though it failed
      callbacks?.onToolStart?.(toolCall.name, toolCall.arguments);

      const errorReason =
        error instanceof ContinueError
          ? error.reason
          : ContinueErrorReason.Unknown;

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      logger.error("Invalid tool call", {
        name: toolCall.name,
        error: errorMessage,
      });

      const duration = Date.now() - startTime;
      telemetryService.logToolResult({
        toolName: toolCall.name,
        success: false,
        durationMs: duration,
        error: errorMessage,
        errorReason,
        // modelName, TODO
      });
      // Add error to chat history
      errorChatEntries.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: errorMessage,
      });

      // Notify about the error
      callbacks?.onToolError?.(errorMessage, toolCall.name);
    }
  }

  return { preprocessedCalls, errorChatEntries };
}

const INTERRUPTED_MESSAGE =
  "Canceled: the session was interrupted before this tool ran";

/**
 * Executes preprocessed tool calls, handling permissions and results
 * @param preprocessedCalls - The preprocessed tool calls ready for execution
 * @param callbacks - Optional callbacks for notifying of events
 * @param getPermissions - The permissions the calls are checked against
 * @returns - Chat history entries with tool results and status information
 */
export async function executeStreamedToolCalls(
  preprocessedCalls: PreprocessedToolCall[],
  callbacks?: StreamCallbacks,
  isHeadless?: boolean,
  signal?: AbortSignal,
  getPermissions: ToolPermissionsSource = readSessionPermissions,
): Promise<{
  hasRejection: boolean;
  chatHistoryEntries: ToolResultWithStatus[];
}> {
  // Strategy: queue permissions (preserve order), then run approved tools in parallel.
  // If any permission is rejected, cancel the remaining tools in this batch.
  //
  // NOTE: parallelToolCallCount is passed to each tool so they can divide their
  // output limits accordingly to avoid context overflow. Bash/Read do this for now
  const parallelToolCallCount = preprocessedCalls.length;

  type IndexedCall = { index: number; call: PreprocessedToolCall };
  const indexedCalls: IndexedCall[] = preprocessedCalls.map((call, index) => ({
    index,
    call,
  }));

  const entriesByIndex = new Map<number, ToolResultWithStatus>();
  const execPromises: Promise<void>[] = [];

  let hasRejection = false;

  // Records a tool call that will not run, so history still has its result
  const cancelCall = (
    index: number,
    call: PreprocessedToolCall,
    message: string,
  ) => {
    entriesByIndex.set(index, {
      role: "tool",
      tool_call_id: call.id,
      content: message,
      status: "canceled",
    });
    callbacks?.onToolResult?.(message, call.name, "canceled");
    // Immediate service update for UI feedback
    try {
      services.chatHistory.addToolResult(call.id, message, "canceled");
    } catch {}
    hasRejection = true;
  };

  // Permission phase (sequential)
  for (const { index, call } of indexedCalls) {
    // Do not cancel subsequent tools after a rejection; handle each independently

    // #12701: never start a tool once the turn has been interrupted
    if (signal?.aborted) {
      cancelCall(index, call, INTERRUPTED_MESSAGE);
      continue;
    }

    try {
      logger.debug("Checking tool permissions", {
        name: call.name,
        arguments: call.arguments,
      });

      // Notify tool start before permission check to display in UI fallbacks
      callbacks?.onToolStart?.(call.name, call.arguments);

      // Check tool permissions using helper
      const permissionResult = await checkToolPermissionApproval(
        await getPermissions(),
        call,
        callbacks,
        isHeadless,
      );

      if (!permissionResult.approved) {
        // Permission denied: create entry with canceled status
        const denialReason = permissionResult.denialReason || "user";
        const deniedMessage =
          denialReason === "policy"
            ? `Command blocked by security policy`
            : `Permission denied by user`;
        cancelCall(index, call, deniedMessage);
        continue;
      }

      // The permission prompt may have waited while the turn was interrupted
      if (signal?.aborted) {
        cancelCall(index, call, INTERRUPTED_MESSAGE);
        continue;
      }

      // Immediately mark as calling for instant UI feedback
      try {
        services.chatHistory.updateToolStatus(call.id, "calling");
      } catch {}

      // Start execution immediately for approved calls
      execPromises.push(
        (async () => {
          try {
            logger.debug("Executing tool", {
              name: call.name,
              arguments: call.arguments,
            });

            const toolResult = capToolResult(
              await executeToolCall(call, {
                parallelToolCallCount,
                signal,
              }),
            );
            const entry: ToolResultWithStatus = {
              role: "tool",
              tool_call_id: call.id,
              content: toolResult,
              status: "done",
            };
            entriesByIndex.set(index, entry);
            callbacks?.onToolResult?.(toolResult, call.name, "done");
            // Immediate service update for UI feedback
            try {
              services.chatHistory.addToolResult(
                call.id,
                String(toolResult),
                "done",
              );
            } catch {}
          } catch (error) {
            // Interrupted between approval and the tool starting
            if (error instanceof ToolInterruptedError) {
              cancelCall(index, call, INTERRUPTED_MESSAGE);
              return;
            }
            const errorMessage = capToolResult(
              `Error executing tool ${call.name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            logger.error("Tool execution failed", {
              name: call.name,
              error: errorMessage,
            });
            entriesByIndex.set(index, {
              role: "tool",
              tool_call_id: call.id,
              content: errorMessage,
              status: "errored",
            });
            callbacks?.onToolError?.(errorMessage, call.name);
            // Immediate service update for UI feedback
            try {
              services.chatHistory.addToolResult(
                call.id,
                errorMessage as string,
                "errored",
              );
            } catch {}
          }
        })(),
      );
    } catch (error) {
      const errorMessage = capToolResult(
        `Error checking permissions for ${call.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      logger.error("Permission check failed", {
        name: call.name,
        error: errorMessage,
      });
      entriesByIndex.set(index, {
        role: "tool",
        tool_call_id: call.id,
        content: errorMessage,
        status: "errored",
      });
      callbacks?.onToolError?.(errorMessage, call.name);
      // Treat permission errors like execution errors but do not stop the batch
      try {
        services.chatHistory.addToolResult(
          call.id,
          errorMessage as string,
          "errored",
        );
      } catch {}
    }
  }

  await Promise.all(execPromises);

  // Assemble final entries in original order
  const chatHistoryEntries: ToolResultWithStatus[] = preprocessedCalls
    .map((_, index) => entriesByIndex.get(index))
    .filter((e): e is ToolResultWithStatus => !!e);

  return {
    hasRejection,
    chatHistoryEntries,
  };
}

// Adds a user message through ChatHistoryService when it is available
export function addUserMessage(
  chatHistory: ChatHistoryItem[],
  content: string,
): ChatHistoryItem[] {
  const chatHistorySvc = services.chatHistory;
  if (
    typeof chatHistorySvc?.isReady === "function" &&
    chatHistorySvc.isReady()
  ) {
    chatHistorySvc.addUserMessage(content);
    return chatHistorySvc.getHistory();
  }
  chatHistory.push({
    message: {
      role: "user",
      content,
    },
    contextItems: [],
  });
  return chatHistory;
}
