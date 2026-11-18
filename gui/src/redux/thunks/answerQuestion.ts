import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import {
  AnswerSet,
  DISMISS_TEXT,
  formatAnswers,
  normalizeQuestionArgs,
} from "@nextcli/ask-question";
import { ContextItem } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";

import { clearQuestionDraft } from "../../util/askQuestionDrafts";
import { selectCurrentToolCalls } from "../selectors/selectToolCalls";
import { acceptToolCall, updateToolCallOutput } from "../slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { findToolCallById } from "../util";
import { saveCurrentSession } from "./session";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

function isOpenQuestion(state: RootState, toolCallId: string): boolean {
  const toolCall = findToolCallById(state.session.history, toolCallId);
  return (
    toolCall?.toolCall.function?.name === BuiltInToolNames.AskQuestion &&
    toolCall.status === "calling"
  );
}

/**
 * Stores the tool result and marks the call done. The status must be "done":
 * constructMessages replaces the output of a canceled call with "The user
 * cancelled this tool call.", and the model would never see the answers.
 */
function finishQuestion(
  dispatch: AppThunkDispatch,
  toolCallId: string,
  content: string,
) {
  const answers: ContextItem = {
    name: "Answers",
    description: "Your answers",
    content,
    hidden: false,
  };
  clearQuestionDraft(toolCallId);
  dispatch(updateToolCallOutput({ toolCallId, contextItems: [answers] }));
  dispatch(acceptToolCall({ toolCallId }));
}

/** Sends the answers to the model and continues the turn. */
export const submitQuestionAnswers = createAsyncThunk<
  void,
  { toolCallId: string; answers: AnswerSet },
  ThunkApiType
>(
  "askQuestion/submit",
  async ({ toolCallId, answers }, { dispatch, getState }) => {
    if (!isOpenQuestion(getState(), toolCallId)) return;
    const toolCall = findToolCallById(getState().session.history, toolCallId)!;
    const content = answers.dismissed
      ? DISMISS_TEXT
      : formatAnswers(normalizeQuestionArgs(toolCall.parsedArgs), answers);
    finishQuestion(dispatch, toolCallId, content);
    // Continues once every tool call in the message is finished, and saves the
    // session when the stream ends.
    unwrapResult(await dispatch(streamResponseAfterToolCall({ toolCallId })));
  },
);

/**
 * Ends the turn without an answer and gives the input back. The model reads
 * the dismissal together with the user's next message. Nothing streams, so the
 * session is saved here.
 */
export const dismissQuestion = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>("askQuestion/dismiss", async ({ toolCallId }, { dispatch, getState }) => {
  if (!isOpenQuestion(getState(), toolCallId)) return;
  finishQuestion(dispatch, toolCallId, DISMISS_TEXT);
  await dispatch(
    saveCurrentSession({ openNewSession: false, generateTitle: false }),
  );
});

/**
 * Dismisses every open question in the current turn. Called before a new user
 * message is added: a call left in "calling" would reach the model as "No tool
 * output".
 */
export function dismissOpenQuestions(
  dispatch: AppThunkDispatch,
  state: RootState,
) {
  for (const toolCall of selectCurrentToolCalls(state)) {
    if (isOpenQuestion(state, toolCall.toolCallId)) {
      finishQuestion(dispatch, toolCall.toolCallId, DISMISS_TEXT);
    }
  }
}
