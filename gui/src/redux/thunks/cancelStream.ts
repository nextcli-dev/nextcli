import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearDanglingMessages,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";
import { finishTurnSnapshotIfDone } from "../../undo/turnSnapshot";

export const cancelStream = createAsyncThunk<void, undefined, ThunkApiType>(
  "chat/cancelStream",
  async (messages, { dispatch, extra, getState }) => {
    const wasStreaming = getState().session.isStreaming;
    dispatch(setInactive());
    dispatch(abortStream());

    // Clear any dangling incomplete tool calls, thinking messages, etc.
    dispatch(clearDanglingMessages());

    // Webview load also lands here, with no turn to finish
    if (wasStreaming) {
      void finishTurnSnapshotIfDone({ dispatch, extra, getState }).then(
        (stored) => {
          if (!stored) return;
          void dispatch(
            saveCurrentSession({ openNewSession: false, generateTitle: false }),
          );
        },
      );
    }
  },
);
