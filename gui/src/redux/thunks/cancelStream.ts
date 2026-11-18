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

    // A stopped turn still gets its end snapshot, so it can be undone.
    // Webview load also lands here; with nothing streaming there is no turn.
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
