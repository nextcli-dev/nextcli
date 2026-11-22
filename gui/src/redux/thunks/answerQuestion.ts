import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import {
  AnswerSet,
  DISMISS_TEXT,
  formatAnswers,
  normalizeQuestionArgs,
} from "@nextcli/ask-question";
import { ContextItem } from "core";

import { clearQuestionDraft } from "../../util/askQuestionDrafts";
import { selectCurrentToolCalls } from "../selectors/selectToolCalls";
import {
  acceptToolCall,
  cancelToolCall,
  errorToolCall,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../store";
import { findToolCallById, isQuestionCall } from "../util";
import { saveCurrentSession } from "./session";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

function isOpenQuestion(state: RootState, toolCallId: string): boolean {
  const toolCall = findToolCallById(state.session.history, toolCallId);
  return (
    !!toolCall && isQuestionCall(toolCall) && toolCall.status === "calling"
  );
}

/**
 * The depth streamResponseAfterToolCall would have had if the question had
 * returned at once: each tool round since the user's message adds 3 (model
 * call, tool call, resume). Answering then counts toward the automatic-round
 * cap instead of starting it over. Taken from the history, so it holds after
 * a reload.
 */
export function resumeDepth(history: RootState["session"]["history"]): number {
  let rounds = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const { message, toolCallStates } = history[i];
    if (message.role === "user") break;
    if (message.role === "assistant" && toolCallStates?.length) rounds++;
  }
  return Math.max(0, 3 * rounds - 1);
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
    unwrapResult(
      await dispatch(
        streamResponseAfterToolCall({
          toolCallId,
          depth: resumeDepth(getState().session.history),
        }),
      ),
    );
  },
);

/**
 * Ends the turn without an answer and gives the input back. The model reads
 * the dismissal together with the user's next message. Calls next to the
 * question that haven't run are canceled; one still running keeps its result,
 * and streamResponseAfterToolCall doesn't continue after a dismissed question.
 * Nothing streams, so the session is saved here.
 */
export const dismissQuestion = createAsyncThunk<
  void,
  { toolCallId: string },
  ThunkApiType
>("askQuestion/dismiss", async ({ toolCallId }, { dispatch, getState }) => {
  if (!isOpenQuestion(getState(), toolCallId)) return;
  finishQuestion(dispatch, toolCallId, DISMISS_TEXT);
  for (const toolCall of selectCurrentToolCalls(getState())) {
    if (toolCall.status === "generating" || toolCall.status === "generated") {
      dispatch(cancelToolCall({ toolCallId: toolCall.toolCallId }));
    }
  }
  await dispatch(
    saveCurrentSession({ openNewSession: false, generateTitle: false }),
  );
});

/**
 * The arguments cannot be shown. Mark the call errored with the normalizer's
 * message and continue the turn, so it does not stay open with no output.
 */
export const failInvalidQuestion = createAsyncThunk<
  void,
  { toolCallId: string; message: string },
  ThunkApiType
>(
  "askQuestion/invalid",
  async ({ toolCallId, message }, { dispatch, getState }) => {
    if (!isOpenQuestion(getState(), toolCallId)) return;
    dispatch(
      errorToolCall({
        toolCallId,
        output: [
          {
            icon: "problems",
            name: "Invalid Tool Call",
            description: "",
            content: message,
            hidden: false,
          },
        ],
      }),
    );
    unwrapResult(
      await dispatch(
        streamResponseAfterToolCall({
          toolCallId,
          depth: resumeDepth(getState().session.history),
        }),
      ),
    );
  },
);

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
