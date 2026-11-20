import type { ChatHistoryItem, Session } from "core/index.js";

import { compactChatHistory, compactionDoneMessage } from "../../compaction.js";
import { updateSessionHistory } from "../../session.js";
import { handleAutoCompaction as coreHandleAutoCompaction } from "../../stream/streamChatResponse.autoCompaction.js";
import { formatError } from "../../util/formatError.js";
import { logger } from "../../util/logger.js";

interface HandleCompactCommandOptions {
  chatHistory: ChatHistoryItem[];
  model: any;
  llmApi: any;
  setChatHistory: React.Dispatch<React.SetStateAction<ChatHistoryItem[]>>;
  setCompactionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  currentSession: Session;
  setCurrentSession: React.Dispatch<React.SetStateAction<Session>>;
  setIsCompacting: (value: boolean) => void;
  setCompactionStartTime: (time: number | null) => void;
  setCompactionAbortController: (controller: AbortController | null) => void;
}

/**
 * Handle compaction command
 */
export async function handleCompactCommand({
  chatHistory,
  model,
  llmApi,
  setChatHistory,
  setCompactionIndex,
  currentSession,
  setCurrentSession,
  setIsCompacting,
  setCompactionStartTime,
  setCompactionAbortController,
}: HandleCompactCommandOptions): Promise<void> {
  // Create abort controller for cancellation support
  const compactionController = new AbortController();
  setCompactionAbortController(compactionController);

  // Start compaction status display
  setIsCompacting(true);
  setCompactionStartTime(Date.now());

  try {
    // Compact the chat history directly (already in unified format) with abort controller
    const result = await compactChatHistory(chatHistory, model, llmApi, {
      abortController: compactionController,
    });

    // Check if operation was aborted before proceeding with success actions
    if (compactionController.signal.aborted) {
      return;
    }

    // Replace chat history with compacted version
    setChatHistory(result.compactedHistory);
    setCompactionIndex(result.compactionIndex);

    // Save the compacted session
    const updatedSession: Session = {
      ...currentSession,
      history: result.compactedHistory,
    };
    updateSessionHistory(result.compactedHistory);
    setCurrentSession(updatedSession);

    // Add success message to chat
    setChatHistory((prev) => [
      ...prev,
      {
        message: {
          role: "system",
          content: compactionDoneMessage(result),
        },
        contextItems: [],
      },
    ]);
  } catch (error) {
    // Check if the error was due to abortion
    if (compactionController.signal.aborted) {
      logger.info("Manual compaction was cancelled by user");
      setChatHistory((prev) => [
        ...prev,
        {
          message: {
            role: "system",
            content: "Compaction cancelled.",
          },
          contextItems: [],
        },
      ]);
    } else {
      logger.error("Compaction failed:", error);
      setChatHistory((prev) => [
        ...prev,
        {
          message: {
            role: "system",
            content: `Compaction failed: ${formatError(error)}`,
          },
          contextItems: [],
        },
      ]);
    }
  } finally {
    // Stop compaction status display
    setIsCompacting(false);
    setCompactionStartTime(null);
    setCompactionAbortController(null);
  }
}

interface HandleAutoCompactionOptions {
  chatHistory: ChatHistoryItem[];
  model: any;
  llmApi: any;
  compactionIndex: number | null;
  setChatHistory: React.Dispatch<React.SetStateAction<ChatHistoryItem[]>>;
  setCompactionIndex: React.Dispatch<React.SetStateAction<number | null>>;
  /** Escape aborts it */
  abortController: AbortController;
  /** The message the compaction runs before */
  message: ChatHistoryItem;
}

/**
 * Auto-compacts before a message when approaching the context limit - TUI
 * wrapper. Returns the history to send, ending with the message, or null
 * when Escape cancelled the compaction: the message is then not sent.
 */
export async function handleAutoCompaction({
  chatHistory,
  model,
  llmApi,
  compactionIndex,
  setChatHistory,
  setCompactionIndex,
  abortController,
  message,
}: HandleAutoCompactionOptions): Promise<{
  newHistory: ChatHistoryItem[];
  currentCompactionIndex: number | null;
} | null> {
  // Delegate to core handleAutoCompaction which decides whether compaction is needed
  // Note: TUI mode doesn't have access to tools/systemMessage at this point,
  // so the core function uses a simplified check.
  const result = await coreHandleAutoCompaction(chatHistory, model, llmApi, {
    isHeadless: false,
    callbacks: {
      setChatHistory,
      setCompactionIndex,
    },
    abortController,
  });

  if (abortController.signal.aborted) {
    return null;
  }

  if (!result.wasCompacted) {
    return {
      newHistory: [...chatHistory, message],
      currentCompactionIndex: compactionIndex,
    };
  }

  return {
    newHistory: [...result.chatHistory, message],
    currentCompactionIndex: result.compactionIndex,
  };
}
