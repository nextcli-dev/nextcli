import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatMessage, ModelDescription } from "core";

import { selectSelectedChatModel } from "../slices/configSlice";
import {
  setCompactionLoading,
  setConversationSummary,
} from "../slices/sessionSlice";
import type { RootState, ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { selectTurnSetup } from "../util/turnSetup";
import { saveCurrentSession } from "./session";

// Compactions the user cancelled: their abort error isn't a failure to report
const cancelled = new Set<string>();
const keyOf = (sessionId: string, index: number) => `${sessionId}:${index}`;

/**
 * The conversation up to `index` as the model sees it in a turn: the same
 * system message, rules, context and tool results. A summary already on the
 * target message is left out, so compacting again starts from the one before.
 */
export function compactionMessages(
  state: RootState,
  model: ModelDescription,
  index: number,
): ChatMessage[] {
  const history = state.session.history.slice(0, index + 1).map((item, i) => {
    const { id, ...message } = item.message;
    return {
      ...item,
      message,
      ...(i === index && { conversationSummary: undefined }),
    };
  });
  const { systemMessage, systemToolsFramework } = selectTurnSetup(state, model);
  return constructMessages(
    history,
    systemMessage,
    state.config.config.rules,
    state.ui.ruleSettings,
    systemToolsFramework,
  ).messages;
}

/**
 * Summarizes the conversation the GUI shows, up to `index`, and stores the
 * summary on that message. A failure is shown as a toast; a cancel isn't.
 */
export const compactConversation = createAsyncThunk<
  void,
  { index: number },
  ThunkApiType
>(
  "session/compactConversation",
  async ({ index }, { dispatch, extra, getState }) => {
    const state = getState();
    const sessionId = state.session.id;
    const model = selectSelectedChatModel(state);
    if (!sessionId || !model || !state.session.history[index]) {
      return;
    }
    const key = keyOf(sessionId, index);
    cancelled.delete(key);
    dispatch(setCompactionLoading({ index, loading: true }));

    try {
      const result = await extra.ideMessenger.request("conversation/compact", {
        index,
        sessionId,
        messages: compactionMessages(state, model, index),
      });
      if (result.status === "error") {
        throw new Error(result.error);
      }
      // Moved to another session, or the message is gone: nothing to apply
      const session = getState().session;
      if (session.id === sessionId && session.history[index]) {
        dispatch(setConversationSummary({ index, summary: result.content }));
        await dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        );
      }
    } catch (error) {
      if (!cancelled.has(key)) {
        void extra.ideMessenger.ide.showToast(
          "error",
          `Compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      cancelled.delete(key);
      if (getState().session.id === sessionId) {
        dispatch(setCompactionLoading({ index, loading: false }));
      }
    }
  },
);

/** Stops the compaction running for the message at `index` */
export const cancelCompaction = createAsyncThunk<
  void,
  { index: number },
  ThunkApiType
>("session/cancelCompaction", async ({ index }, { extra, getState }) => {
  const sessionId = getState().session.id;
  if (!sessionId) {
    return;
  }
  cancelled.add(keyOf(sessionId, index));
  await extra.ideMessenger.request("conversation/compact/abort", {
    index,
    sessionId,
  });
});
