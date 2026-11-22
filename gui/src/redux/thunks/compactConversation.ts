import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ChatMessage } from "core";

import { isTurnOver } from "../../undo/turnSnapshot";
import {
  ChatHistoryItemWithMessageId,
  setCompactionLoading,
  setConversationSummary,
} from "../slices/sessionSlice";
import type { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { getSession, saveCurrentSession, updateSession } from "./session";

interface Compaction {
  sessionId: string;
  cancelled: boolean;
}

// Compactions in progress, by message id: one per message
const running = new Map<string, Compaction>();

/**
 * The conversation up to `index`, to summarize: attached context, tool
 * results and any earlier summary. The agent prompt, rules and tool
 * instructions are left out, since the summary request has no tools. A
 * summary already on the target message is left out too, so compacting
 * again starts from the one before.
 */
function compactionMessages(
  history: ChatHistoryItemWithMessageId[],
  index: number,
): ChatMessage[] {
  const items = history.slice(0, index + 1).map((item, i) => {
    const { id, ...message } = item.message;
    return {
      ...item,
      message,
      ...(i === index && { conversationSummary: undefined }),
    };
  });
  return constructMessages(items, undefined, [], {}).messages;
}

/**
 * Summarizes the conversation up to the message at `index` and stores the
 * summary on that message, found by its id: in the open session, or in its
 * saved file when another session was opened meanwhile. A failure is shown
 * as a toast; a cancel isn't.
 */
export const compactConversation = createAsyncThunk<
  void,
  { index: number },
  ThunkApiType
>(
  "session/compactConversation",
  async ({ index }, { dispatch, extra, getState }) => {
    const state = getState();
    const { id: sessionId, history } = state.session;
    const messageId = history[index]?.message.id;
    // Mid-turn, the summary would cut off the rest of the turn
    if (
      !sessionId ||
      !messageId ||
      running.has(messageId) ||
      !isTurnOver(state)
    ) {
      return;
    }
    const compaction: Compaction = { sessionId, cancelled: false };
    running.set(messageId, compaction);
    dispatch(setCompactionLoading({ messageId, loading: true }));

    try {
      const result = await extra.ideMessenger.request("conversation/compact", {
        sessionId,
        messageId,
        messages: compactionMessages(history, index),
      });
      if (compaction.cancelled) {
        return;
      }
      if (result.status === "error") {
        // An error without text was already shown to the user
        if (result.error) {
          throw new Error(result.error);
        }
        return;
      }
      const { summary, shortenedOutputs } = result.content;

      const session = getState().session;
      if (session.id === sessionId) {
        // Not when the message was deleted or undone meanwhile
        if (session.history.some((item) => item.message.id === messageId)) {
          dispatch(setConversationSummary({ messageId, summary }));
          unwrapResult(
            await dispatch(
              saveCurrentSession({
                openNewSession: false,
                generateTitle: false,
              }),
            ),
          );
        }
      } else {
        const saved = await getSession(extra.ideMessenger, sessionId);
        // Saved by the GUI, so its messages keep their ids
        const savedHistory = saved.history as ChatHistoryItemWithMessageId[];
        if (savedHistory.some((item) => item.message.id === messageId)) {
          unwrapResult(
            await dispatch(
              updateSession({
                ...saved,
                history: savedHistory.map((item) =>
                  item.message.id === messageId
                    ? { ...item, conversationSummary: summary }
                    : item,
                ),
              }),
            ),
          );
        }
      }

      if (shortenedOutputs > 0) {
        void extra.ideMessenger.ide.showToast(
          "info",
          `Compacted. ${shortenedOutputs} tool outputs were shortened to fit the summary request.`,
        );
      }
    } catch (error) {
      if (!compaction.cancelled) {
        void extra.ideMessenger.ide.showToast(
          "error",
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      running.delete(messageId);
      dispatch(setCompactionLoading({ messageId, loading: false }));
    }
  },
);

/** Stops the compaction of this message; whatever it returns is discarded */
export const cancelCompaction = createAsyncThunk<
  void,
  { messageId: string },
  ThunkApiType
>("session/cancelCompaction", async ({ messageId }, { extra }) => {
  const compaction = running.get(messageId);
  if (!compaction) {
    return;
  }
  compaction.cancelled = true;
  await extra.ideMessenger.request("conversation/compact/abort", {
    sessionId: compaction.sessionId,
    messageId,
  });
});
