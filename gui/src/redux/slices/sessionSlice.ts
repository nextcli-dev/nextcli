import {
  ActionReducerMapBuilder,
  AsyncThunk,
  PayloadAction,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  AssistantChatMessage,
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  ContextItemWithId,
  FileSymbolMap,
  McpUiState,
  MessageModes,
  PromptLog,
  RuleMetadata,
  Session,
  ThinkingChatMessage,
  Tool,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  renderContextItems,
} from "core/util/messageContent";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";
import { findLastIndex } from "lodash";
import { v4 as uuidv4 } from "uuid";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { toolCallCtxItemToCtxItemWithId } from "../../pages/gui/ToolCallDiv/utils";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";
import { RootState } from "../store";
import { streamResponseThunk } from "../thunks/streamResponse";
import {
  findChatHistoryItemByToolCallId,
  findToolCallById,
  isQuestionCall,
  STOPPED_TOOL_CALL_NAME,
} from "../util";

interface StoppedOutputs {
  description: string;
  /** The output of a call that was running */
  running: string;
  /**
   * The output of a call whose arguments the model was still writing. Without
   * it, that call and one waiting for approval are canceled. With it, a call
   * waiting for approval is kept, so its approval bar comes back
   */
  unwritten?: string;
}

/**
 * Ends what these items still show as running: reasoning stops, and a running
 * tool call fails with `stopped.running` as its output (see
 * isStoppedToolCall). An open question stays open: it waits for the user, not
 * a tool, and answering it continues the turn.
 */
function stopRunningItems(
  items: ChatHistoryItemWithMessageId[],
  stopped: StoppedOutputs,
) {
  const fail = (toolCallState: ToolCallState, content: string) => {
    toolCallState.status = "errored";
    toolCallState.output = [
      {
        icon: "problems",
        name: STOPPED_TOOL_CALL_NAME,
        description: stopped.description,
        content,
        hidden: false,
      },
    ];
  };
  for (const item of items) {
    if (item.reasoning?.active) {
      item.reasoning.active = false;
      item.reasoning.endAt = Date.now();
    }
    for (const toolCallState of item.toolCallStates ?? []) {
      const { status } = toolCallState;
      if (status === "calling" && !isQuestionCall(toolCallState)) {
        fail(toolCallState, stopped.running);
      } else if (stopped.unwritten === undefined) {
        if (status === "generating" || status === "generated") {
          toolCallState.status = "canceled";
        }
      } else if (status === "generating") {
        fail(toolCallState, stopped.unwritten);
      }
    }
  }
}

/** Whether the summary at `index` is the latest one, the one requests use */
function isSummaryInUse(state: SessionState, index: number): boolean {
  return (
    state.history.findLastIndex((item) => !!item.conversationSummary) === index
  );
}

/**
 * Both measures fall short of what requests send once the summary between
 * them is gone, so the larger is the closer one. It is kept whole: its
 * pruned flag belongs to its own breakdown, not to the other request's.
 */
function largerMeasure(a: ContextMeasure, b: ContextMeasure): ContextMeasure {
  const aScore = a.contextPercentage ?? -1;
  const bScore = b.contextPercentage ?? -1;
  return aScore >= bScore ? a : b;
}

/**
 * Helper function to filter out duplicate edit/search-replace tool calls.
 * Only keeps the first occurrence of edit tools.
 *
 * We don't support multiple parallel apply calls - see tool definitions for
 * instructions we provide to models to prevent this behavior.
 */
/**
 * Marks the reasoning streamed in the current turn with the stream's
 * Thinking mode, so it stays hidden or shown when the selected model or its
 * settings change later. Earlier turns are already marked.
 */
function stampThinkingHidden(state: SessionState) {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const item = state.history[i];
    if (item.message.role === "user") break;
    const hasReasoning = item.message.role === "thinking" || !!item.reasoning;
    if (hasReasoning && item.thinkingHidden === undefined) {
      item.thinkingHidden = !!state.streamThinkingHidden;
    }
  }
}

function filterMultipleEditToolCalls(
  toolCalls: ToolCallDelta[],
): ToolCallDelta[] {
  let hasSeenEditTool = false;

  return toolCalls.filter((toolCall) => {
    if (toolCall.function?.name && isEditTool(toolCall.function?.name)) {
      if (hasSeenEditTool) {
        return false; // Skip this duplicate edit tool
      }
      hasSeenEditTool = true;
    }

    return true;
  });
}

/**
 * Initializes tool call states for a new message containing tool calls.
 * This function is called when we receive a complete message with tool calls,
 * typically in non-streaming scenarios or when processing the first chunk
 * of a streaming message that contains tool calls.
 *
 * @param message - The chat message containing tool calls to process
 * @param lastItem - The chat history item to attach tool call states to
 */
export function handleToolCallsInMessage(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    (message.role === "assistant" || message.role === "thinking") &&
    message.toolCalls?.length
  ) {
    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Initialize tool call states for each filtered tool call in the message
    // Each tool call gets its own state to track generation/execution progress
    lastItem.toolCallStates = filteredToolCalls.map((toolCallDelta) =>
      addToolCallDeltaToState(toolCallDelta, undefined),
    );

    // Update the message's toolCalls array to reflect the processed tool calls
    // We can safely cast because we verified the role above
    const curMessage = lastItem.message as
      | AssistantChatMessage
      | ThinkingChatMessage;
    curMessage.toolCalls = lastItem.toolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

/**
 * Applies a single tool call delta to the tool call states array.
 *
 * This function handles the core logic for OpenAI-style tool call streaming where:
 * - Initial tool calls come with full details (ID, name, arguments)
 * - Subsequent argument fragments come without IDs and need to update the most recent tool call
 * - Multiple parallel tool calls can be streamed simultaneously
 *
 * @param toolCallDelta - The incoming tool call delta from the LLM stream
 * @param toolCallStates - Array of existing tool call states (modified in place)
 */
function applyToolCallDelta(
  toolCallDelta: ToolCallDelta,
  toolCallStates: ToolCallState[],
): void {
  // Find existing state by matching toolCallId - this ensures we update
  // the correct tool call even when multiple tool calls are being streamed
  let existingStateIndex = -1;

  if (toolCallDelta.id) {
    // Tool call has an ID - find by exact match
    // This handles: new tool calls or explicit updates to existing ones
    existingStateIndex = toolCallStates.findIndex(
      (state) => state.toolCallId === toolCallDelta.id,
    );
  } else {
    // No ID in delta (common in OpenAI streaming fragments)
    // Strategy: Update the most recently added tool call that's still being generated
    // This handles the pattern: initial tool call with ID, then fragments without ID
    existingStateIndex = toolCallStates.length - 1;

    // Ensure we have at least one tool call to update
    if (existingStateIndex < 0) {
      existingStateIndex = -1; // Will create new tool call
    }
  }

  const existingState =
    existingStateIndex >= 0 ? toolCallStates[existingStateIndex] : undefined;

  // Apply the delta to create an updated state (either updating existing or creating new)
  const updatedState = addToolCallDeltaToState(toolCallDelta, existingState);

  if (existingStateIndex >= 0) {
    // Update existing tool call state in place
    toolCallStates[existingStateIndex] = updatedState;
  } else {
    // Add new tool call state for a newly discovered tool call
    toolCallStates.push(updatedState);
  }
}

/**
 * Handles incremental updates to tool calls during streaming responses.
 * This function processes streaming deltas for tool calls, updating existing
 * tool call states or creating new ones as needed. It uses ID-based matching
 * to ensure tool call updates are applied to the correct tool call state.
 *
 * @param message - The streaming message chunk containing tool call deltas
 * @param lastItem - The chat history item containing existing tool call states
 */
export function handleStreamingToolCallUpdates(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    message.role === "assistant" &&
    message.toolCalls?.length &&
    lastItem.message.role === "assistant"
  ) {
    // Start with existing tool call states or empty array if none exist
    const existingToolCallStates = lastItem.toolCallStates || [];
    const updatedToolCallStates: ToolCallState[] = [...existingToolCallStates];

    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Process each filtered tool call delta, matching by ID to update the correct state
    filteredToolCalls.forEach((toolCallDelta) => {
      applyToolCallDelta(toolCallDelta, updatedToolCallStates);
    });

    // Replace the entire tool call states array with the updated version
    lastItem.toolCallStates = updatedToolCallStates;

    // Update the message's toolCalls array to reflect current tool call states
    (lastItem.message as any).toolCalls = updatedToolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
};

type SessionState = {
  lastSessionId?: string;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  title: string;
  id: string;
  streamAborter: AbortController;
  mainEditorContentTrigger?: JSONContent | undefined;
  symbols: FileSymbolMap;
  mode: MessageModes;
  isInEdit: boolean;
  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;
  isPruned?: boolean;
  /** Whether the current stream's Thinking mode is Hidden */
  streamThinkingHidden?: boolean;
  contextPercentage?: number;
  contextSnapshot?: import("core").CompiledMessagesResult["snapshot"];
  /**
   * The chat model (by title) and mode the measure was taken for. Another
   * model or mode sends a different request, so the measure doesn't apply.
   */
  contextMeasuredFor?: { model: string; mode: MessageModes };
  inlineErrorMessage?: InlineErrorMessageType;
  /** Compactions in progress, by the id of the message they summarize */
  compactionLoading: Record<string, boolean>;
  /**
   * The context measure from before each summary requests use, by the id of
   * its message, put back when that summary is deleted
   */
  contextBeforeSummary: Record<string, ContextMeasure>;
  /** Redo is offered until the next message */
  undoneTurn?: UndoneTurn;
};

type ContextMeasure = Pick<
  SessionState,
  "isPruned" | "contextPercentage" | "contextSnapshot" | "contextMeasuredFor"
>;

export interface UndoneTurn {
  roots: {
    root: string;
    targets: { path: string; tree: string; written?: boolean }[];
  }[];
  removedHistory?: ChatHistoryItemWithMessageId[];
}

export const INITIAL_SESSION_STATE: SessionState = {
  isSessionMetadataLoading: false,
  allSessionMetadata: [],
  history: [],
  isStreaming: false,
  title: NEW_SESSION_TITLE,
  id: uuidv4(),
  streamAborter: new AbortController(),
  symbols: {},
  mode: "agent",
  isInEdit: false,
  codeBlockApplyStates: {
    states: [],
    curIndex: 0,
  },
  lastSessionId: undefined,
  newestToolbarPreviewForInput: {},
  compactionLoading: {},
  contextBeforeSummary: {},
};

export const sessionSlice = createSlice({
  name: "session",
  initialState: INITIAL_SESSION_STATE,
  reducers: {
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }

      const lastMessage = state.history[state.history.length - 1];
      // The prompt is the whole conversation again, so keeping it made a
      // session grow with the square of its calls. Dev data records it
      // under NEXTCLI_TRACE=full.
      const logs = payload.map(({ prompt, ...log }) => log);

      lastMessage.promptLogs = lastMessage.promptLogs
        ? lastMessage.promptLogs.concat(logs)
        : logs;

      // Inactive thinking for reasoning models when '</think>' tag is not received on request completion
      if (lastMessage.reasoning?.active) {
        lastMessage.reasoning.active = false;
        lastMessage.reasoning.endAt = Date.now();
      }
    },
    setActive: (state) => {
      state.isStreaming = true;
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      const curMessage = state.history.at(-1);
      if (curMessage) {
        curMessage.isGatheringContext = payload;
      }
    },
    clearDanglingMessages: (state) => {
      // This is used during cancellation
      // After the last user or tool message, we can have thinking and or valid assitant message (content or generated tool calls) OR nothing.
      // The only thing allowed after the last assistant message that has either content or generated tool calls
      // is a user or tool message
      if (state.history.length < 2) {
        return;
      }

      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      let validAssistantMessageIdx = -1;
      for (let i = state.history.length - 1; i > lastUserOrToolIdx; i--) {
        const message = state.history[i];
        const hasGeneratedMsg = message.toolCallStates?.some(
          (toolCallState) => toolCallState.status !== "generating",
        );
        if (message.message.content || hasGeneratedMsg) {
          validAssistantMessageIdx = i;
          // Cancel any tool calls that are dangling and generated
          if (message.toolCallStates) {
            message.toolCallStates.forEach((toolCallState) => {
              if (
                toolCallState.status === "generated" ||
                toolCallState.status === "generating"
              ) {
                toolCallState.status = "canceled";
              }
            });
          }
          break;
        }
      }

      if (validAssistantMessageIdx === -1) {
        const lastMsg = state.history[lastUserOrToolIdx];
        const lastRole = lastMsg.message.role as "user" | "tool";
        if (lastRole === "user") {
          state.mainEditorContentTrigger = lastMsg.editorState;
          state.history = state.history.slice(0, lastUserOrToolIdx);
        } else {
          state.history = state.history.slice(0, lastUserOrToolIdx + 1);
        }
      } else {
        state.history = state.history.slice(0, validAssistantMessageIdx + 1);
      }
    },
    /**
     * Closes a running turn before its session is left. Unlike
     * clearDanglingMessages (the Stop button), it keeps the prompt and any
     * reasoning in history and never moves the prompt to the input box,
     * which by then belongs to another session.
     */
    closeTurnForLeaving: (state) => {
      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      const turn = state.history.slice(lastUserOrToolIdx + 1).filter((item) => {
        const isEmptyPlaceholder =
          item.message.role === "assistant" &&
          !renderChatMessage(item.message).trim() &&
          !item.reasoning?.text?.trim() &&
          !item.toolCallStates?.length;
        return !isEmptyPlaceholder;
      });

      // The tool may still finish; its result goes nowhere now
      stopRunningItems(turn, {
        description: "Session switched",
        running:
          "The session was switched while this tool was running. Its result was not recorded.",
      });

      state.history = state.history
        .slice(0, lastUserOrToolIdx + 1)
        .concat(turn);
    },
    // Trigger value picked up by editor with isMainInput to set its content
    setMainEditorContentTrigger: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorContentTrigger = action.payload;
    },
    updateFileSymbols: (state, action: PayloadAction<FileSymbolMap>) => {
      state.symbols = {
        ...state.symbols,
        ...action.payload,
      };
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.history[index].contextItems = contextItems;
      }
    },
    submitEditorAndInitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const { index, editorState } = payload;
      // A new message makes the last undo final
      state.undoneTurn = undefined;

      if (state.history.length && index < state.history.length) {
        // Resubmission - update input message, truncate history after resubmit with new empty response message
        if (index % 2 === 1) {
          console.warn(
            "Corrupted history: resubmitting at odd index, shouldn't happen",
          );
        }
        const historyItem = state.history[index];

        historyItem.message.content = ""; // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
        historyItem.editorState = payload.editorState;
        historyItem.contextItems = [];

        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
      } else {
        // New input/response messages
        state.history = state.history.concat([
          {
            message: {
              id: uuidv4(),
              role: "user",
              content: "", // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
            },
            contextItems: [],
            editorState,
          },
          {
            message: {
              id: uuidv4(),
              role: "assistant",
              content: "", // IMPORTANT - this is subsequently updated by response streaming
            },
            contextItems: [],
          },
        ]);
      }

      state.isStreaming = true;
    },
    truncateHistoryToMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
      }>,
    ) => {
      const { index } = payload;

      if (state.history.length && index < state.history.length) {
        state.codeBlockApplyStates.curIndex = 0;
        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
        state.inlineErrorMessage = undefined;
        state.isPruned = false;
        state.contextPercentage = undefined;
        state.contextSnapshot = undefined;
        state.contextMeasuredFor = undefined;
      }
    },
    truncateHistoryFrom: (state, action: PayloadAction<number>) => {
      state.history = state.history.slice(0, action.payload);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextSnapshot = undefined;
      state.contextMeasuredFor = undefined;
    },
    appendHistory: (
      state,
      action: PayloadAction<ChatHistoryItemWithMessageId[]>,
    ) => {
      state.history.push(...action.payload);
    },
    setUndoneTurn: (state, action: PayloadAction<UndoneTurn | undefined>) => {
      state.undoneTurn = action.payload;
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.history.splice(action.payload - 1, 2);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextSnapshot = undefined;
      state.contextMeasuredFor = undefined;
    },
    setConversationSummary: (
      state,
      action: PayloadAction<{ messageId: string; summary: string }>,
    ) => {
      const { messageId, summary } = action.payload;
      const index = state.history.findIndex(
        (item) => item.message.id === messageId,
      );
      if (index === -1) {
        return;
      }
      state.history[index].conversationSummary = summary;
      // A later summary is still the one requests use
      if (!isSummaryInUse(state, index)) {
        return;
      }
      // Kept for a delete of the summary; compacting the message again
      // keeps the measure from before its first summary
      const current = {
        isPruned: state.isPruned,
        contextPercentage: state.contextPercentage,
        contextSnapshot: state.contextSnapshot,
        contextMeasuredFor: state.contextMeasuredFor,
      };
      const before = state.contextBeforeSummary[messageId];
      state.contextBeforeSummary[messageId] = before
        ? largerMeasure(before, current)
        : current;
      // Measured before the summary; the next request reports the new size
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextSnapshot = undefined;
      state.contextMeasuredFor = undefined;
    },
    deleteCompaction: (state, action: PayloadAction<{ messageId: string }>) => {
      const { messageId } = action.payload;
      const index = state.history.findIndex(
        (item) => item.message.id === messageId,
      );
      if (index === -1) {
        return;
      }
      const inUse = isSummaryInUse(state, index);
      state.history[index].conversationSummary = undefined;
      const before = state.contextBeforeSummary[messageId];
      delete state.contextBeforeSummary[messageId];
      // Requests send the history before the summary again: put back what
      // was measured then, or a later request's measure if it is larger
      if (inUse && before) {
        const restored = largerMeasure(before, {
          isPruned: state.isPruned,
          contextPercentage: state.contextPercentage,
          contextSnapshot: state.contextSnapshot,
          contextMeasuredFor: state.contextMeasuredFor,
        });
        state.isPruned = restored.isPruned;
        state.contextPercentage = restored.contextPercentage;
        state.contextSnapshot = restored.contextSnapshot;
        state.contextMeasuredFor = restored.contextMeasuredFor;
      }
    },
    updateHistoryItemAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const { index, updates } = payload;
      if (index !== 0 && !state.history[index]) {
        console.error(
          `attempting to update history item at nonexistent index ${index}`,
          updates,
        );
        return;
      }
      state.history[index] = {
        ...state.history[index],
        ...updates,
      };
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];

      if (!historyItem) {
        return;
      }

      historyItem.contextItems = [
        ...historyItem.contextItems,
        ...payload.contextItems,
      ];
    },
    setAppliedRulesAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      if (state.history[payload.index]) {
        state.history[payload.index].appliedRules = payload.appliedRules;
      }
    },
    setInactive: (state) => {
      const curMessage = state.history.at(-1);

      if (curMessage) {
        curMessage.isGatheringContext = false;
      }

      state.isStreaming = false;
    },
    abortStream: (state) => {
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage[]>) => {
      if (state.history.length) {
        for (const message of action.payload) {
          let lastItem = state.history[state.history.length - 1];
          let lastMessage = lastItem.message;

          if (message.role === "thinking" && message.redactedThinking) {
            state.history.push({
              message: {
                role: "thinking",
                content: "internal reasoning is hidden due to safety reasons",
                redactedThinking: message.redactedThinking,
                id: uuidv4(),
              },
              contextItems: [],
            });
            continue;
          }

          const messageContent = message.content
            ? renderChatMessage(message)
            : "";

          // OpenAI-compatible models in agent mode sometimes send
          // all of their data in one message, so we handle that case early.
          if (messageContent && message.role !== "tool") {
            const thinkMatches = messageContent.match(
              /<think>([\s\S]*)<\/think>([\s\S]*)/,
            );
            if (thinkMatches) {
              // The order that they seem to consistently use is:
              //
              // <think>Thinking text</think>
              // Text to show to the user

              lastItem.reasoning = {
                text: thinkMatches[1].trim(),
                startAt: Date.now(),
                endAt: Date.now(),
                active: false,
              };

              // This is the chat message that we should show to the user.
              // We always need to push this even if it is empty,
              // because we cannot attach tool calls to a Thinking message.
              // That would break `messageHasToolCallId`.
              state.history.push({
                message: {
                  role: "assistant",
                  content: thinkMatches[2].trim(),
                  id: uuidv4(),
                },
                contextItems: [],
              });
              lastItem = state.history[state.history.length - 1];
              lastMessage = lastItem.message;

              handleToolCallsInMessage(message, lastItem);

              // On to the next chunk of the batch, not out of the reducer
              continue;
            }
          }

          // The remainder of this function handles streaming messages
          if (
            lastMessage.role !== message.role ||
            message.role === "tool" // Tool messages should always create new messages
          ) {
            // Create a new message
            const historyItem: ChatHistoryItemWithMessageId = {
              message: {
                ...message,
                content: "", // Start with empty content, let accumulation logic handle it
                // Same for reasoning_details, so the first chunk is not merged into itself
                ...(message.role === "thinking"
                  ? { reasoning_details: undefined }
                  : {}),
                id: uuidv4(),
              },
              contextItems: [],
            };
            state.history.push(historyItem);
            lastItem = state.history[state.history.length - 1];
            lastMessage = lastItem.message;
          }

          // Add to the existing message
          if (messageContent) {
            if (messageContent.includes("<think>") && message.role !== "tool") {
              lastItem.reasoning = {
                startAt: Date.now(),
                active: true,
                text: messageContent.replace("<think>", "").trim(),
              };
            } else if (
              lastItem.reasoning?.active &&
              messageContent.includes("</think>")
            ) {
              const [reasoningEnd, answerStart] =
                messageContent.split("</think>");
              lastItem.reasoning.text += reasoningEnd.trimEnd();
              lastItem.reasoning.active = false;
              lastItem.reasoning.endAt = Date.now();
              lastMessage.content += answerStart.trimStart();
            } else if (lastItem.reasoning?.active) {
              if (
                lastItem.reasoning.text.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastItem.reasoning.text += messageContent;
              }
            } else {
              // Note this only works because new message above
              // was already rendered from parts to string
              if (
                lastMessage.content.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastMessage.content += messageContent;
              }
            }
          } else if (message.role === "thinking" && message.signature) {
            if (lastMessage.role === "thinking") {
              lastMessage.signature = message.signature;
            }
          }

          // Not an else: a chunk can carry text and tool calls together
          if (
            message.role === "assistant" &&
            message.toolCalls?.length &&
            lastMessage.role === "assistant"
          ) {
            handleStreamingToolCallUpdates(message, lastItem);
          }

          // Attach Responses API output item id to the current assistant message if present
          // fromResponsesChunk sets message.metadata.responsesOutputItemId when it sees output_item.added for messages
          if (
            message.role === "assistant" &&
            lastMessage.role === "assistant" &&
            message.metadata?.responsesOutputItemId
          ) {
            lastMessage.metadata = lastMessage.metadata || {};
            // Accumulate fc_ IDs for parallel tool calls (OpenAI Responses API)
            if (!lastMessage.metadata.responsesOutputItemIds) {
              lastMessage.metadata.responsesOutputItemIds = [];
            }
            (lastMessage.metadata.responsesOutputItemIds as string[]).push(
              message.metadata.responsesOutputItemId as string,
            );
            // Also keep singular for backwards compatibility
            lastMessage.metadata.responsesOutputItemId = message.metadata
              .responsesOutputItemId as string;
          }

          if (
            message.role === "thinking" &&
            message.reasoning_details &&
            lastMessage.role === "thinking"
          ) {
            lastMessage.reasoning_details = mergeReasoningDetails(
              lastMessage.reasoning_details,
              message.reasoning_details,
            );
          }
        }
        stampThinkingHidden(state);
      }
    },
    setStreamThinkingHidden: (state, action: PayloadAction<boolean>) => {
      state.streamThinkingHidden = action.payload;
    },
    newSession: (state, { payload }: PayloadAction<Session | undefined>) => {
      state.lastSessionId = state.id;
      state.undoneTurn = undefined;
      state.contextBeforeSummary = {};

      state.streamAborter.abort();
      state.streamAborter = new AbortController();

      state.isStreaming = false;
      state.symbols = {};

      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.contextSnapshot = undefined;
      state.contextMeasuredFor = undefined;

      if (payload) {
        state.history = payload.history as any;
        // Nothing runs yet for a session that is only now loaded. A file
        // saved mid-turn (the editor reloaded, or the extension host stopped
        // answering before the next save) would otherwise spin forever. Calls
        // waiting for approval are saved that way on purpose, and stay
        stopRunningItems(state.history, {
          description: "Interrupted",
          running:
            "This tool was still running when the session was last saved, and the session was loaded again before it finished. Its result was not recorded.",
          unwritten:
            "The model was still writing this tool call when the session was last saved, so it never ran.",
        });
        state.title = payload.title;
        state.id = payload.sessionId;
        if (payload.mode) {
          state.mode = payload.mode;
        }
      } else {
        state.history = [];
        state.title = NEW_SESSION_TITLE;
        state.id = uuidv4();
      }
    },
    updateSessionTitle: (state, { payload }: PayloadAction<string>) => {
      state.title = payload;
    },
    setIsSessionMetadataLoading: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.isSessionMetadataLoading = payload;
    },
    setAllSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata[]>,
    ) => {
      state.allSessionMetadata = payload;
    },
    //////////////////////////////////////////////////////////////////////////////////
    // These are for optimistic session metadata updates, especially for History page
    addSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata>,
    ) => {
      state.allSessionMetadata = [...state.allSessionMetadata, payload];
    },
    updateSessionMetadata: (
      state,
      {
        payload,
      }: PayloadAction<
        {
          sessionId: string;
        } & Partial<BaseSessionMetadata>
      >,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.map((session) =>
        session.sessionId === payload.sessionId
          ? {
              ...session,
              ...payload,
            }
          : session,
      );
      if (payload.title && payload.sessionId === state.id) {
        state.title = payload.title;
      }
    },
    deleteSessionMetadata: (state, { payload }: PayloadAction<string>) => {
      // Note, should not be allowed to delete current session from chat session
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (session) => session.sessionId !== payload,
      );
    },
    //////////////////////////////////////////////////////////////////////////////////
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];

      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });

      const { relativePathOrBasename } = findUriInDirs(
        payload.rangeInFileWithContents.filepath,
        window.workspacePaths ?? [],
      );
      const fileName = getUriPathBasename(
        payload.rangeInFileWithContents.filepath,
      );

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;

      contextItems.push({
        name: `${fileName} ${lineNums}`,
        description: relativePathOrBasename,
        id: {
          providerTitle: "code",
          itemId: uuidv4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
        uri: {
          type: "file",
          value: payload.rangeInFileWithContents.filepath,
        },
      });

      state.history[state.history.length - 1].contextItems = contextItems;
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const applyState = state.codeBlockApplyStates.states.find(
        (state) => state.streamId === payload.streamId,
      );

      if (!applyState) {
        state.codeBlockApplyStates.states.push(payload);
      } else {
        applyState.status = payload.status ?? applyState.status;
        applyState.numDiffs = payload.numDiffs ?? applyState.numDiffs;
        applyState.filepath = payload.filepath ?? applyState.filepath;
        applyState.fileContent = payload.fileContent ?? applyState.fileContent;
        applyState.originalFileContent =
          payload.originalFileContent ?? applyState.originalFileContent;
        applyState.destructiveWarning =
          payload.destructiveWarning ?? applyState.destructiveWarning;
      }

      if (payload.status === "done") {
        state.codeBlockApplyStates.curIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.codeBlockApplyStates.curIndex = 0;
    },

    // TOOL CALL STATE
    setToolGenerated: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        tools: Tool[];
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );

      if (toolCallState) {
        toolCallState.status = "generated";

        const tool = action.payload.tools.find(
          (t) => t.function.name === toolCallState.toolCall.function.name,
        );
        if (tool) {
          toolCallState.tool = tool;
        }
      }
    },
    updateToolCallOutput: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        contextItems: ContextItem[];
        mcpUiState?: McpUiState;
      }>,
    ) => {
      // Update tool call state and corresponding tool output message
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.output = action.payload.contextItems;
        toolCallState.mcpUiState = action.payload.mcpUiState;
      }
      const toolItem = findChatHistoryItemByToolCallId(
        state.history,
        action.payload.toolCallId,
      );
      if (toolItem) {
        toolItem.message.content = renderContextItems(
          action.payload.contextItems,
        );
        toolItem.contextItems = action.payload.contextItems.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, action.payload.toolCallId),
        );
      }
    },
    setProcessedToolCallArgs: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        newArgs: Record<string, any>;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.processedArgs = action.payload.newArgs;
      }
    },
    cancelToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "canceled";
      }
    },
    setToolCallRememberRules: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        rememberRules: string[] | undefined;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.rememberRules = action.payload.rememberRules;
      }
    },
    errorToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        output?: ContextItem[]; // optional for convenience
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "errored";
        if (action.payload.output) {
          toolCallState.output = action.payload.output;
        }
      }
    },
    acceptToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "done";
      }
    },
    setToolCallCalling: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "calling";
      }
    },
    setMode: (state, action: PayloadAction<MessageModes>) => {
      state.mode = action.payload;
    },
    setIsInEdit: (state, action: PayloadAction<boolean>) => {
      state.isInEdit = action.payload;
    },
    setNewestToolbarPreviewForInput: (
      state,
      {
        payload,
      }: PayloadAction<{
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      state.newestToolbarPreviewForInput[payload.inputId] =
        payload.contextItemId;
    },
    setCompactionLoading: (
      state,
      action: PayloadAction<{ messageId: string; loading: boolean }>,
    ) => {
      const { messageId, loading } = action.payload;
      if (loading) {
        state.compactionLoading[messageId] = true;
      } else {
        delete state.compactionLoading[messageId];
      }
    },
    setInlineErrorMessage: (
      state,
      action: PayloadAction<SessionState["inlineErrorMessage"]>,
    ) => {
      state.inlineErrorMessage = action.payload;
    },
    setIsPruned: (state, action: PayloadAction<boolean>) => {
      state.isPruned = action.payload;
    },
    setContextPercentage: (state, action: PayloadAction<number>) => {
      state.contextPercentage = action.payload;
    },
    setContextSnapshot: (
      state,
      action: PayloadAction<SessionState["contextSnapshot"]>,
    ) => {
      state.contextSnapshot = action.payload;
      // A new measure; setContextMeasuredFor says what it was taken for
      state.contextMeasuredFor = undefined;
    },
    setContextMeasuredFor: (
      state,
      action: PayloadAction<SessionState["contextMeasuredFor"]>,
    ) => {
      state.contextMeasuredFor = action.payload;
    },
  },
  selectors: {
    selectIsGatheringContext: (state) => {
      const curHistoryItem = state.history.at(-1);
      return curHistoryItem?.isGatheringContext || false;
    },
  },
  extraReducers: (builder) => {
    addPassthroughCases(builder, [streamResponseThunk]);
  },
});

function addPassthroughCases(
  builder: ActionReducerMapBuilder<SessionState>,
  thunks: AsyncThunk<any, any, any>[],
) {
  thunks.forEach((thunk) => {
    builder
      .addCase(thunk.fulfilled, (_state, _action) => {})
      .addCase(thunk.rejected, (_state, _action) => {})
      .addCase(thunk.pending, (_state, _action) => {});
  });
}

export const selectApplyStateByStreamId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, streamId?: string) => streamId,
  ],
  (states, streamId) => {
    return states.find((state) => state.streamId === streamId);
  },
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (state: RootState) => state.session.codeBlockApplyStates.states,
    (_state: RootState, toolCallId?: string) => toolCallId,
  ],
  (states, toolCallId) => {
    if (toolCallId) {
      return states.find((state) => state.toolCallId === toolCallId);
    }
  },
);

export const {
  updateFileSymbols,
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setAppliedRulesAtIndex,
  setInactive,
  streamUpdate,
  newSession,
  updateSessionTitle,
  addHighlightedCode,
  addPromptCompletionPair,
  setActive,
  submitEditorAndInitAtIndex,
  truncateHistoryToMessage,
  updateHistoryItemAtIndex,
  clearDanglingMessages,
  closeTurnForLeaving,
  setMainEditorContentTrigger,
  deleteMessage,
  truncateHistoryFrom,
  appendHistory,
  setUndoneTurn,
  deleteCompaction,
  setConversationSummary,
  setIsGatheringContext,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  abortStream,
  setToolCallCalling,
  cancelToolCall,
  errorToolCall,
  setToolCallRememberRules,
  acceptToolCall,
  setToolGenerated,
  updateToolCallOutput,
  setProcessedToolCallArgs,
  setMode,
  setIsSessionMetadataLoading,
  setAllSessionMetadata,
  addSessionMetadata,
  updateSessionMetadata,
  deleteSessionMetadata,
  setNewestToolbarPreviewForInput,
  setIsInEdit,
  setInlineErrorMessage,
  setIsPruned,
  setContextPercentage,
  setContextSnapshot,
  setContextMeasuredFor,
  setCompactionLoading,
  setStreamThinkingHidden,
} = sessionSlice.actions;

export const { selectIsGatheringContext } = sessionSlice.selectors;

export default sessionSlice.reducer;
