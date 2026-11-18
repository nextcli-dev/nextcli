import type { ChatHistoryItem } from "core/index.js";

import { services } from "../../services/index.js";
import type { OpenTurn, UndoPlan } from "../../services/SnapshotService.js";
import { describeReason } from "../../services/SnapshotService.js";
import { getCurrentSession } from "../../session.js";
import { logger } from "../../util/logger.js";

function lastUserIndex(history: readonly ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].message.role === "user") return i;
  }
  return -1;
}

/**
 * Snapshots the work tree before the turn that answers the last user message
 * and stores the snapshot on that message.
 */
export async function beginTurnSnapshot(): Promise<OpenTurn | undefined> {
  const snapshot = services.snapshot;
  if (!snapshot.isEnabled()) return undefined;
  const history = services.chatHistory.getHistory();
  const index = lastUserIndex(history);
  if (index < 0) return undefined;
  const begun = await snapshot.beginTurn(
    getCurrentSession().sessionId,
    history[index].checkpoint,
  );
  if (!begun) return undefined;
  if (!history[index].checkpoint) {
    services.chatHistory.setCheckpoint(index, begun.checkpoint);
  }
  return begun.turn;
}

/** Records the end of the turn on the user message that started it. */
export async function finishTurnSnapshot(turn: OpenTurn): Promise<void> {
  const checkpoint = await services.snapshot.finishTurn(turn);
  if (!checkpoint) return;
  // Find the message by its start snapshot: compaction may have moved it.
  const history = services.chatHistory.getHistory();
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.message.role !== "user") continue;
    if (item.checkpoint?.roots.some((root) => root.start === turn.start)) {
      services.chatHistory.setCheckpoint(i, checkpoint);
      return;
    }
  }
  logger.debug("The turn's message is gone; its end snapshot isn't stored");
}

export type RestoreMode = "code-and-conversation" | "code";

/** What `/undo` should do with the current history. */
export function findUndoTarget(
  history: readonly ChatHistoryItem[],
): { fromIndex: number } | { message: string } {
  const snapshot = services.snapshot;
  if (!snapshot.isEnabled()) {
    return {
      message: `Undo is off: ${describeReason(snapshot.getState().reason)}.`,
    };
  }
  const fromIndex = snapshot.lastUndoableIndex(history);
  if (fromIndex === undefined) {
    return { message: "Nothing to undo: no turn in this chat has a snapshot." };
  }
  return { fromIndex };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Restores the files of `plan` and, for "code-and-conversation", returns the
 * history without the undone turns. Returns the text to show afterwards.
 */
export async function applyUndo(
  history: readonly ChatHistoryItem[],
  plan: UndoPlan,
  mode: RestoreMode,
): Promise<{ history?: ChatHistoryItem[]; message: string }> {
  const removed =
    mode === "code-and-conversation"
      ? history.slice(plan.fromIndex)
      : undefined;
  const result = await services.snapshot.undo(plan, removed);
  const parts = [
    `Restored ${plural(result.restored.length, "file")}`,
    `deleted ${plural(result.deleted.length, "file")}`,
  ];
  let message = `${parts.join(", ")}. Use /redo to put them back.`;
  if (result.keptIgnored.length > 0) {
    message += ` Kept ${result.keptIgnored.join(", ")}: ignored by git.`;
  }
  if (result.skipped.length > 0) {
    message += ` Submodules aren't restored: ${result.skipped.join(", ")}.`;
  }
  if (mode === "code-and-conversation") {
    message += " Press ↑ to recall the prompt.";
  }
  const running = services.backgroundJobs.getRunningJobCount();
  if (running > 0) {
    message += ` ${plural(running, "background job")} still running may change files again.`;
  }
  return {
    history: removed ? history.slice(0, plan.fromIndex) : undefined,
    message,
  };
}

/** Re-applies the last undo. */
export async function applyRedo(
  history: readonly ChatHistoryItem[],
): Promise<{ history?: ChatHistoryItem[]; message: string }> {
  if (!services.snapshot.isEnabled()) {
    return {
      message: `Redo is off: ${describeReason(services.snapshot.getState().reason)}.`,
    };
  }
  const redone = await services.snapshot.redo();
  if (!redone) return { message: "Nothing to redo." };
  const { result, removedHistory } = redone;
  const changed = result.restored.length + result.deleted.length;
  return {
    history: removedHistory ? [...history, ...removedHistory] : undefined,
    message: `Re-applied the undone turn (${plural(changed, "file")}).`,
  };
}
