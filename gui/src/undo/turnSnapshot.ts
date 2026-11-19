import { createAsyncThunk } from "@reduxjs/toolkit";
import type { ChatHistoryItem } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";

import {
  appendHistory,
  ChatHistoryItemWithMessageId,
  setUndoneTurn,
  truncateHistoryFrom,
  updateHistoryItemAtIndex,
} from "../redux/slices/sessionSlice";
import { AppThunkDispatch, RootState, ThunkApiType } from "../redux/store";
import { saveCurrentSession } from "../redux/thunks/session";

type TurnCheckpoint = NonNullable<ChatHistoryItem["checkpoint"]>;
type RestoreTarget = { path: string; tree: string; written?: boolean };

export type UndoMode = "code-and-conversation" | "code";

export interface UndoPlan {
  fromIndex: number;
  turns: number;
  roots: {
    root: string;
    plan: {
      targets: RestoreTarget[];
      restore: string[];
      delete: string[];
      conflicts: string[];
      skipped: string[];
    };
  }[];
}

const ACTIVE_TOOL_STATUSES = new Set(["generating", "generated", "calling"]);

function joinPath(root: string, file: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${file}`;
}

function checkpointsFrom(
  history: readonly ChatHistoryItem[],
  fromIndex: number,
): TurnCheckpoint[] {
  return history
    .slice(fromIndex)
    .filter((item) => item.message.role === "user" && item.checkpoint)
    .map((item) => item.checkpoint!);
}

export function lastUndoableIndex(
  history: readonly ChatHistoryItem[],
): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user" && history[i].checkpoint) return i;
  }
  return undefined;
}

/** Nothing streams, no tool call waits or runs, every edit is closed. */
export function isTurnOver(state: RootState): boolean {
  const { session } = state;
  if (session.isStreaming) return false;
  const lastUser = session.history.findLastIndex(
    (item) => item.message.role === "user",
  );
  const toolBusy = session.history
    .slice(lastUser + 1)
    .some((item) =>
      item.toolCallStates?.some((t) => ACTIVE_TOOL_STATUSES.has(t.status)),
    );
  const applyBusy = session.codeBlockApplyStates.states.some(
    (s) => s.status !== undefined && s.status !== "closed",
  );
  return !toolBusy && !applyBusy;
}

// Plain functions, not thunks: without a work tree they dispatch nothing
interface ThunkApi {
  dispatch: AppThunkDispatch;
  getState: () => RootState;
  extra: ThunkApiType["extra"];
}

export async function beginTurnSnapshot(
  { dispatch, extra }: ThunkApi,
  index: number,
): Promise<void> {
  let result;
  try {
    result = await extra.ideMessenger.request("snapshot/capture", undefined);
  } catch (e) {
    console.warn("Turn snapshot failed", e);
    return;
  }
  if (result.status !== "success" || result.content.roots.length === 0) {
    return;
  }
  dispatch(
    updateHistoryItemAtIndex({
      index,
      updates: {
        checkpoint: {
          v: 1,
          roots: result.content.roots.map((r) => ({
            root: r.root,
            start: r.tree,
          })),
        },
      },
    }),
  );
}

const FILE_WRITING_TOOLS = new Set<string>([
  BuiltInToolNames.CreateNewFile,
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
]);

// One at a time: each replaces the turn's checkpoint
let preserving: Promise<unknown> = Promise.resolve();

/** Saves an ignored file an edit tool will write. Never throws. */
export function preserveBeforeToolWrite(
  api: ThunkApi,
  toolName: string,
  args: unknown,
): Promise<void> {
  const filepath = (args as { filepath?: unknown } | undefined)?.filepath;
  if (!FILE_WRITING_TOOLS.has(toolName) || typeof filepath !== "string") {
    return Promise.resolve();
  }
  const next = preserving.then(() => preserveNow(api, filepath));
  preserving = next.catch(() => {});
  return next.catch((e) => console.warn("Saving a file for undo failed", e));
}

async function preserveNow(
  { dispatch, extra, getState }: ThunkApi,
  filepath: string,
): Promise<void> {
  const state = getState();
  const history = state.session.history;
  const index = history.findLastIndex((item) => item.message.role === "user");
  const checkpoint = history[index]?.checkpoint;
  if (!checkpoint) return;
  const result = await extra.ideMessenger.request("snapshot/preserve", {
    checkpoint,
    filepaths: [filepath],
  });
  if (result.status !== "success") return;
  if (JSON.stringify(result.content) === JSON.stringify(checkpoint)) return;
  const at = getState().session.history.findIndex(
    (item) => item.checkpoint === checkpoint,
  );
  if (at < 0) return;
  dispatch(
    updateHistoryItemAtIndex({
      index: at,
      updates: { checkpoint: result.content },
    }),
  );
}

const finishing = new Set<string>();

/**
 * Edit tools resume a turn from separate events, so this runs after every
 * part of it; a later part updates the end. Returns whether it stored one.
 */
export async function finishTurnSnapshotIfDone({
  dispatch,
  extra,
  getState,
}: ThunkApi): Promise<boolean> {
  await preserving;
  const state = getState();
  const history = state.session.history;
  const index = history.findLastIndex((item) => item.message.role === "user");
  const checkpoint = history[index]?.checkpoint;
  if (!checkpoint || !isTurnOver(state)) return false;
  const key = checkpoint.roots.map((root) => root.start).join(",");
  if (finishing.has(key)) return false;
  finishing.add(key);
  try {
    const edited = state.session.codeBlockApplyStates.states
      .map((s) => s.filepath)
      .filter((f): f is string => !!f);
    if (edited.length > 0) {
      await extra.ideMessenger.request("snapshot/syncDocuments", {
        filepaths: edited,
        action: "save",
      });
    }
    const result = await extra.ideMessenger.request("snapshot/finishTurn", {
      checkpoint,
    });
    if (result.status !== "success") return false;
    const now = getState().session.history;
    const at = now.findIndex((item) => item.checkpoint === checkpoint);
    if (at < 0) return false;
    dispatch(
      updateHistoryItemAtIndex({
        index: at,
        updates: { checkpoint: result.content },
      }),
    );
    return true;
  } catch (e) {
    console.warn("End-of-turn snapshot failed", e);
    return false;
  } finally {
    finishing.delete(key);
  }
}

export const planUndo = createAsyncThunk<
  UndoPlan,
  { fromIndex: number },
  ThunkApiType
>("snapshot/planUndo", async ({ fromIndex }, { extra, getState }) => {
  const checkpoints = checkpointsFrom(getState().session.history, fromIndex);
  if (checkpoints.length === 0) {
    throw new Error("This message has no snapshot to restore.");
  }
  const result = await extra.ideMessenger.request("snapshot/planRevert", {
    checkpoints,
  });
  if (result.status !== "success") throw new Error(result.error);
  return { fromIndex, turns: checkpoints.length, roots: result.content.roots };
});

async function restoreAndReload(
  extra: ThunkApiType["extra"],
  roots: { root: string; targets: RestoreTarget[] }[],
) {
  const result = await extra.ideMessenger.request("snapshot/restore", {
    roots,
  });
  if (result.status !== "success") throw new Error(result.error);
  const restored = result.content.roots.flatMap(({ root, result: r }) =>
    (r?.restored ?? []).map((file) => joinPath(root, file)),
  );
  if (restored.length > 0) {
    await extra.ideMessenger.request("snapshot/syncDocuments", {
      filepaths: restored,
      action: "reload",
    });
  }
  return result.content.roots;
}

export const applyUndo = createAsyncThunk<
  void,
  { plan: UndoPlan; mode: UndoMode },
  ThunkApiType
>(
  "snapshot/applyUndo",
  async ({ plan, mode }, { dispatch, extra, getState }) => {
    const results = await restoreAndReload(
      extra,
      plan.roots.map(({ root, plan: p }) => ({ root, targets: p.targets })),
    );
    const failure = results.find((r) => r.error);
    const history = getState().session.history;
    let removedHistory: ChatHistoryItemWithMessageId[] | undefined;
    // Partly undone: keep the conversation
    if (mode === "code-and-conversation" && !failure) {
      removedHistory = history.slice(plan.fromIndex);
      dispatch(truncateHistoryFrom(plan.fromIndex));
    }
    const roots = results.flatMap(({ root, result }) =>
      result
        ? [
            {
              root,
              targets: (
                plan.roots.find((p) => p.root === root)?.plan.targets ?? []
              ).map((t) => ({ ...t, tree: result.redoTree })),
            },
          ]
        : [],
    );
    if (roots.length > 0 || removedHistory) {
      dispatch(setUndoneTurn({ roots, removedHistory }));
    }
    await dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
    if (failure) {
      throw new Error(
        `Undo stopped partway: ${failure.error}` +
          (roots.length > 0 ? " Redo puts back what it changed." : ""),
      );
    }
  },
);

export const applyRedo = createAsyncThunk<void, undefined, ThunkApiType>(
  "snapshot/applyRedo",
  async (_, { dispatch, extra, getState }) => {
    const undone = getState().session.undoneTurn;
    if (!undone) return;
    const results = await restoreAndReload(extra, undone.roots);
    const failure = results.find((r) => r.error);
    if (failure) throw new Error(`Redo stopped partway: ${failure.error}`);
    if (undone.removedHistory) {
      dispatch(appendHistory(undone.removedHistory));
    }
    dispatch(setUndoneTurn(undefined));
    await dispatch(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );
  },
);
