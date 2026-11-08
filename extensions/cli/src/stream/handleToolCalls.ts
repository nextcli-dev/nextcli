import type { ChatHistoryItem, Reasoning, ToolStatus } from "core/index.js";
import { generateOpenAIToolCallId } from "core/tools/systemMessageTools/systemToolUtils.js";
import { stripImages } from "core/util/messageContent.js";
import { createHistoryItem } from "core/util/messageConversion.js";

import {
  checkToolPermission,
  isAllowedForSomeArguments,
} from "src/permissions/permissionChecker.js";

import {
  SERVICE_NAMES,
  serviceContainer,
  services,
} from "../services/index.js";
import type { ToolPermissionServiceState } from "../services/ToolPermissionService.js";
import {
  convertToolToChatCompletionTool,
  getAllAvailableTools,
  Tool,
  ToolCall,
} from "../tools/index.js";
import { logger } from "../util/logger.js";

import { getAgentLoopLimits, toolCallFingerprint } from "./agentLoopLimits.js";
import {
  capToolResult,
  executeStreamedToolCalls,
  preprocessStreamedToolCalls,
} from "./streamChatResponse.helpers.js";
import { StreamCallbacks } from "./streamChatResponse.types.js";

interface HandleToolCallsOptions {
  toolCalls: ToolCall[];
  chatHistory: ChatHistoryItem[];
  content: string;
  callbacks: StreamCallbacks | undefined;
  isHeadless: boolean;
  usage?: any;
  /** The model's reasoning for this response, kept so it can be sent back */
  reasoning?: Reasoning;
  /** Aborted when the turn is interrupted; remaining tools are not run */
  signal?: AbortSignal;
}

function hasReasoning(reasoning: Reasoning | undefined): boolean {
  return !!reasoning?.text || !!reasoning?.details?.length;
}

function parseToolArguments(args: string | undefined): unknown {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return args;
  }
}

/** Tool calls already in history, oldest first */
function getPriorToolCalls(
  history: ChatHistoryItem[],
): { id: string; fingerprint: string }[] {
  const calls: { id: string; fingerprint: string }[] = [];
  for (const item of history) {
    if (item.message.role !== "assistant") continue;
    for (const tc of item.message.toolCalls ?? []) {
      if (!tc.id) continue;
      calls.push({
        id: tc.id,
        fingerprint: toolCallFingerprint(
          tc.function?.name ?? "",
          parseToolArguments(tc.function?.arguments),
        ),
      });
    }
  }
  return calls;
}

/**
 * Providers sometimes reuse a tool call id within or across turns (#12626).
 * Both OpenAI and Anthropic reject a history with duplicate ids, so give
 * colliding calls a fresh id before they are stored.
 */
function rewriteCollidingToolCallIds(
  toolCalls: ToolCall[],
  priorIds: Set<string>,
): void {
  const seen = new Set(priorIds);
  for (const tc of toolCalls) {
    if (!tc.id || seen.has(tc.id)) {
      const newId = generateOpenAIToolCallId();
      logger.warn("Rewriting duplicate tool call id", {
        oldId: tc.id,
        newId,
      });
      tc.id = newId;
    }
    seen.add(tc.id);
  }
}

/**
 * Finds calls that repeat the same tool with the same arguments more than
 * maxIdenticalToolCalls times in a row (#12702), counting earlier turns.
 */
function findRepeatedToolCalls(
  toolCalls: ToolCall[],
  priorFingerprints: string[],
): Set<string> {
  const { maxIdenticalToolCalls } = getAgentLoopLimits();
  const sequence = [...priorFingerprints];
  const repeated = new Set<string>();
  for (const tc of toolCalls) {
    const fingerprint = toolCallFingerprint(tc.name, tc.arguments);
    let run = 0;
    for (let i = sequence.length - 1; i >= 0; i--) {
      if (sequence[i] !== fingerprint) break;
      run++;
    }
    if (run >= maxIdenticalToolCalls) {
      repeated.add(tc.id);
    }
    sequence.push(fingerprint);
  }
  return repeated;
}

export async function handleToolCalls(
  options: HandleToolCallsOptions,
): Promise<boolean> {
  const {
    toolCalls,
    chatHistory,
    content,
    callbacks,
    isHeadless,
    usage,
    reasoning,
    signal,
  } = options;
  const chatHistorySvc = services.chatHistory;
  const useService =
    typeof chatHistorySvc?.isReady === "function" && chatHistorySvc.isReady();
  if (toolCalls.length === 0) {
    // A reply can be reasoning only. It's stored so it shows and survives
    // /resume; it isn't sent back (see convertFromUnifiedHistory)
    if (content || hasReasoning(reasoning)) {
      if (useService) {
        // Service-driven: write assistant message via service
        chatHistorySvc.addAssistantMessage(
          content,
          undefined,
          usage,
          reasoning,
        );
      } else {
        // Fallback only when service is unavailable
        const message: any = {
          role: "assistant",
          content,
        };
        if (usage) {
          message.usage = usage;
        }
        chatHistory.push({ ...createHistoryItem(message), reasoning });
      }
    }
    return false;
  }

  const history =
    useService && typeof chatHistorySvc.getHistory === "function"
      ? chatHistorySvc.getHistory()
      : chatHistory;
  const priorToolCalls = getPriorToolCalls(history);
  rewriteCollidingToolCallIds(
    toolCalls,
    new Set(priorToolCalls.map((tc) => tc.id)),
  );
  const repeatedCallIds = findRepeatedToolCalls(
    toolCalls,
    priorToolCalls.map((tc) => tc.fingerprint),
  );

  // Create tool call states for the ChatHistoryItem
  const toolCallStates = toolCalls.map((tc) => ({
    toolCallId: tc.id,
    toolCall: {
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    },
    status: "generated" as ToolStatus,
    parsedArgs: tc.arguments,
  }));

  // Create assistant message with tool calls
  const assistantMessage = {
    role: "assistant" as const,
    content: content || "",
    toolCalls: toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
      ...(tc.extra_content && { extra_content: tc.extra_content }),
    })),
  };

  if (useService) {
    // Important: pass ChatCompletion-style toolCalls, not internal ToolCall[]
    chatHistorySvc.addAssistantMessage(
      assistantMessage.content || "",
      assistantMessage.toolCalls,
      usage,
      reasoning,
    );
  } else {
    // Fallback only when service is unavailable
    const messageWithUsage = usage
      ? { ...assistantMessage, usage }
      : assistantMessage;
    chatHistory.push({
      ...createHistoryItem(messageWithUsage, [], toolCallStates),
      reasoning,
    });
  }

  // Cancel calls that repeat the same tool with the same arguments, so a
  // model stuck in a loop gets told instead of re-running the tool
  for (const tc of toolCalls) {
    if (!repeatedCallIds.has(tc.id)) continue;
    const message = `Skipped: ${tc.name} was already called with these exact arguments ${getAgentLoopLimits().maxIdenticalToolCalls} times in a row. Use the earlier result or try a different approach.`;
    logger.warn("Canceling repeated tool call", { name: tc.name });
    callbacks?.onToolStart?.(tc.name, tc.arguments);
    callbacks?.onToolResult?.(message, tc.name, "canceled");
    if (useService) {
      chatHistorySvc.addToolResult(tc.id, message, "canceled");
    } else {
      const toolState = toolCallStates.find((ts) => ts.toolCallId === tc.id);
      if (toolState) {
        toolState.status = "canceled";
        (toolState as any).output = [
          {
            content: message,
            name: "Tool Result",
            description: "Tool execution result",
          },
        ];
      }
    }
  }

  // First preprocess the tool calls
  const { preprocessedCalls, errorChatEntries } =
    await preprocessStreamedToolCalls(
      isHeadless,
      toolCalls.filter((tc) => !repeatedCallIds.has(tc.id)),
      callbacks,
    );

  // Add any preprocessing errors to the toolCallStates on the assistant message
  // (NOT as separate history items, which would cause duplicate tool_result messages)
  errorChatEntries.forEach((errorEntry) => {
    const errorContent = capToolResult(stripImages(errorEntry.content) || "");
    if (useService) {
      chatHistorySvc.addToolResult(
        errorEntry.tool_call_id,
        errorContent,
        "errored",
      );
    } else {
      // Fallback only when service is unavailable: update local tool state
      const lastAssistantIndex = chatHistory.findLastIndex(
        (item) => item.message.role === "assistant" && item.toolCallStates,
      );
      if (
        lastAssistantIndex >= 0 &&
        chatHistory[lastAssistantIndex].toolCallStates
      ) {
        const toolState = chatHistory[lastAssistantIndex].toolCallStates.find(
          (ts) => ts.toolCallId === errorEntry.tool_call_id,
        );
        if (toolState) {
          toolState.status = "errored";
          toolState.output = [
            {
              content: errorContent,
              name: `Tool Result`,
              description: "Tool execution result",
            },
          ];
        }
      }
    }
  });

  // Execute the valid preprocessed tool calls
  // Note: executeStreamedToolCalls adds tool results to toolCallStates via
  // services.chatHistory.addToolResult() internally
  const { hasRejection } = await executeStreamedToolCalls(
    preprocessedCalls,
    callbacks,
    isHeadless,
    signal,
  );

  if (isHeadless && hasRejection) {
    logger.debug(
      "Tool call rejected in headless mode - returning current content",
    );
    return true; // Signal early return needed
  }

  // Tool results are already added to toolCallStates in executeStreamedToolCalls
  // via services.chatHistory.addToolResult() - no need to add them again here.
  // Adding them again would be redundant (and previously caused duplicate tool_result messages
  // when combined with separate tool history items).
  return false;
}

export async function getRequestTools(isHeadless: boolean) {
  const availableTools = await getAllAvailableTools(isHeadless);

  const permissionsState =
    await serviceContainer.get<ToolPermissionServiceState>(
      SERVICE_NAMES.TOOL_PERMISSIONS,
    );

  const allowedTools: Tool[] = [];
  for (const tool of availableTools) {
    const result = checkToolPermission(
      { name: tool.name, arguments: {} },
      permissionsState.permissions,
    );

    if (
      result.permission === "allow" ||
      (result.permission === "ask" && !isHeadless) ||
      isAllowedForSomeArguments(tool.name, permissionsState.permissions)
    ) {
      allowedTools.push(tool);
    }
  }

  return allowedTools.map(convertToolToChatCompletionTool);
}
