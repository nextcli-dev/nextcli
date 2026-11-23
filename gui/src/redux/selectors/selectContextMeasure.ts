import { createSelector } from "@reduxjs/toolkit";
import { selectSelectedChatModel } from "../slices/configSlice";
import type { RootState } from "../store";

/**
 * The last request's context measure, or none when it was taken for another
 * chat model or mode: those send a different system prompt, tools and
 * window, so the next request is measured again.
 */
export const selectContextMeasure = createSelector(
  [
    (state: RootState) => state.session.contextSnapshot,
    (state: RootState) => state.session.contextPercentage,
    (state: RootState) => state.session.isPruned,
    (state: RootState) => state.session.contextMeasuredFor,
    (state: RootState) => state.session.mode,
    (state: RootState) => selectSelectedChatModel(state)?.title,
  ],
  (snapshot, contextPercentage, isPruned, measuredFor, mode, modelTitle) => {
    const stale =
      !!measuredFor &&
      (measuredFor.mode !== mode || measuredFor.model !== modelTitle);
    return stale
      ? { snapshot: undefined, contextPercentage: undefined, isPruned: false }
      : { snapshot, contextPercentage, isPruned: !!isPruned };
  },
);
