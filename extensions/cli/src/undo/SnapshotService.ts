import * as path from "path";

import {
  openSnapshotter,
  RestoreError,
  type RestoreResult,
  type RestoreTarget,
  type RevertPlan,
  type Snapshotter,
  type TurnCheckpoint,
  type TurnSnapshot,
} from "@nextcli/snapshot";
import type { ChatHistoryItem } from "core/index.js";

import { env } from "../env.js";
import { BaseService } from "../services/BaseService.js";
import { logger } from "../util/logger.js";

export interface SnapshotServiceState {
  enabled: boolean;
  /** Why snapshots are off, when they are. */
  reason?: string;
  /** Top level of the git work tree being snapshotted. */
  root?: string;
  canRedo: boolean;
}

export interface SnapshotServiceOptions {
  enabled: boolean;
  cwd?: string;
  storeRoot?: string;
}

export interface UndoPlan {
  /** History index of the first user message being undone. */
  fromIndex: number;
  /** Number of turns with a checkpoint that will be undone. */
  turns: number;
  plan: RevertPlan;
}

interface RedoEntry {
  /** The undo's targets, with the tree of the state before the undo. */
  targets: RestoreTarget[];
  /** History removed by the undo, put back by redo. */
  removedHistory?: ChatHistoryItem[];
}

/** A turn whose start was captured and whose end is still to come. */
export interface OpenTurn {
  /** Grows when a file tool is about to write an ignored file. */
  start: string;
  pinPrefix: string;
  /** Ignored files the turn's file tools wrote (see `preserve`). */
  written: string[];
}

/**
 * Undo needs someone to ask for it, so only the terminal UI snapshots the
 * work tree. Headless runs, `cn serve` and the `cn review` workers never do.
 */
export function shouldSnapshot(
  options: { headless?: boolean; snapshots?: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = environment.NEXTCLI_SNAPSHOTS?.trim().toLowerCase();
  const offByEnv = value === "0" || value === "false" || value === "off";
  return !options.headless && options.snapshots !== false && !offByEnv;
}

/**
 * Records the work tree before and after each agent turn in the terminal UI,
 * so `/undo`, `/redo` and the rewind picker can put files back. Headless runs,
 * `cn serve` and `cn review` never create it.
 */
export class SnapshotService extends BaseService<SnapshotServiceState> {
  private snapshotter: Snapshotter | undefined;
  private redoStack: RedoEntry[] = [];
  private opening: Promise<void> = Promise.resolve();
  private background: Promise<unknown> = Promise.resolve();
  /** Preserves run one at a time: each extends the turn's start. */
  private preserving: Promise<unknown> = Promise.resolve();
  private preserveCount = 0;

  constructor() {
    super("SnapshotService", { enabled: false, canRedo: false });
  }

  async doInitialize(
    options: SnapshotServiceOptions = { enabled: false },
  ): Promise<SnapshotServiceState> {
    this.snapshotter = undefined;
    this.redoStack = [];
    if (!options.enabled) {
      this.opening = Promise.resolve();
      return { enabled: false, reason: "off", canRedo: false };
    }
    // Open the store in the background: starting the terminal UI never waits
    // for git. The first turn waits for it instead (see beginTurn).
    this.opening = this.open(options);
    return { enabled: false, reason: "starting", canRedo: false };
  }

  private async open(options: SnapshotServiceOptions): Promise<void> {
    try {
      const result = await openSnapshotter({
        cwd: options.cwd ?? process.cwd(),
        storeRoot:
          options.storeRoot ?? path.join(env.continueHome, "snapshots"),
      });
      if (!result.ok) {
        logger.debug("Snapshots are off", result);
        this.setState({ enabled: false, reason: result.reason });
        return;
      }
      const snapshotter = result.snapshotter;
      this.snapshotter = snapshotter;
      this.setState({
        enabled: true,
        reason: undefined,
        root: snapshotter.toplevel,
      });
      // The first capture hashes the whole tree; do it now rather than on
      // the first turn. Then drop snapshots older than the retention period.
      this.background = snapshotter
        .capture()
        .then(() => snapshotter.prune())
        .catch((error) => logger.debug("Snapshot warm-up failed", { error }));
    } catch (error) {
      logger.debug("Snapshots couldn't be set up", { error });
      this.setState({ enabled: false, reason: "error" });
    }
  }

  isEnabled(): boolean {
    return !!this.snapshotter;
  }

  /** Waits until the store is open and warmed up. */
  async settled(): Promise<void> {
    await this.opening;
    await this.background;
  }

  /**
   * Captures the work tree before a turn runs any tool. A new prompt also
   * makes the last undo final, so redo is no longer offered.
   * Returns undefined when snapshots are off or the capture failed; a turn
   * never fails because of a snapshot.
   */
  async beginTurn(
    sessionId: string,
    existing?: TurnCheckpoint,
  ): Promise<{ checkpoint: TurnCheckpoint; turn: OpenTurn } | undefined> {
    await this.opening;
    const snapshotter = this.snapshotter;
    if (!snapshotter) return undefined;
    this.clearRedo();
    // Resuming an interrupted turn keeps the snapshot from its first start.
    const root = existing?.roots.find((r) => r.root === snapshotter.toplevel);
    const pinPrefix = `${sessionId}/${Date.now()}`;
    try {
      const start =
        root?.start ?? (await snapshotter.capture(`${pinPrefix}/start`));
      const written = root?.written ?? [];
      return {
        checkpoint: {
          v: 1,
          roots: [
            {
              root: snapshotter.toplevel,
              start,
              ...(written.length > 0 ? { written } : {}),
            },
          ],
        },
        turn: { start, pinPrefix, written: [...written] },
      };
    } catch (error) {
      logger.warn("Could not snapshot the work tree before the turn", {
        error,
      });
      return undefined;
    }
  }

  /**
   * Called before a file tool writes `paths`. Saves the current bytes of
   * the ignored ones, which snapshots leave out, into the turn's start.
   * Returns the turn's checkpoint when it changed, so the caller can store
   * it; an interrupted turn then still covers those files.
   */
  preserve(
    turn: OpenTurn,
    paths: string[],
  ): Promise<TurnCheckpoint | undefined> {
    const next = this.preserving.then(async () => {
      const snapshotter = this.snapshotter;
      if (!snapshotter) return undefined;
      const count = ++this.preserveCount;
      const result = await snapshotter.preserve(
        turn,
        paths,
        `${turn.pinPrefix}/start-${count}`,
      );
      if (
        result.start === turn.start &&
        result.written.length === turn.written.length
      ) {
        return undefined;
      }
      turn.start = result.start;
      turn.written = result.written;
      return {
        v: 1 as const,
        roots: [
          {
            root: snapshotter.toplevel,
            start: turn.start,
            written: turn.written,
          },
        ],
      };
    });
    this.preserving = next.catch(() => {});
    return next;
  }

  /** Captures the end of a turn and the files it changed. */
  async finishTurn(turn: OpenTurn): Promise<TurnCheckpoint | undefined> {
    const snapshotter = this.snapshotter;
    if (!snapshotter) return undefined;
    try {
      await this.preserving;
      const { end, files } = await snapshotter.finishTurn(
        turn.start,
        `${turn.pinPrefix}/end`,
        turn.written,
      );
      return {
        v: 1,
        roots: [
          {
            root: snapshotter.toplevel,
            start: turn.start,
            end,
            files,
            ...(turn.written.length > 0 ? { written: turn.written } : {}),
          },
        ],
      };
    } catch (error) {
      logger.warn("Could not snapshot the work tree after the turn", {
        error,
      });
      return undefined;
    }
  }

  /** History index of the last user message that can be undone. */
  lastUndoableIndex(history: readonly ChatHistoryItem[]): number | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      if (this.turnSnapshot(history[i])) return i;
    }
    return undefined;
  }

  /** Whether the user message at `index` has a snapshot to restore. */
  canRestore(history: readonly ChatHistoryItem[], index: number): boolean {
    return !!this.turnSnapshot(history[index]);
  }

  /** Works out what undoing every turn from `fromIndex` on would change. */
  async planUndo(
    history: readonly ChatHistoryItem[],
    fromIndex: number,
  ): Promise<UndoPlan> {
    const snapshotter = this.requireSnapshotter();
    const turns = this.turnsFrom(history, fromIndex);
    if (turns.length === 0) {
      throw new Error("This message has no snapshot to restore.");
    }
    return {
      fromIndex,
      turns: turns.length,
      plan: await snapshotter.planRevert(turns),
    };
  }

  /**
   * Restores the files of a plan. With `removedHistory`, redo also puts
   * those messages back.
   */
  async undo(
    plan: UndoPlan,
    removedHistory?: ChatHistoryItem[],
  ): Promise<RestoreResult> {
    const snapshotter = this.requireSnapshotter();
    const pushRedo = (redoTree: string) => {
      this.redoStack.push({
        targets: plan.plan.targets.map((t) => ({ ...t, tree: redoTree })),
        removedHistory,
      });
      this.setState({ canRedo: true });
    };
    try {
      const result = await snapshotter.restore(plan.plan.targets);
      pushRedo(result.redoTree);
      return result;
    } catch (error) {
      // Some files already changed; redo can still put them back.
      if (error instanceof RestoreError) pushRedo(error.redoTree);
      throw error;
    }
  }

  /** Re-applies the last undo. Returns the messages to put back, if any. */
  async redo(): Promise<
    { result: RestoreResult; removedHistory?: ChatHistoryItem[] } | undefined
  > {
    const snapshotter = this.requireSnapshotter();
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    try {
      const result = await snapshotter.restore(entry.targets);
      return { result, removedHistory: entry.removedHistory };
    } catch (error) {
      this.redoStack.push(entry);
      throw error;
    } finally {
      this.setState({ canRedo: this.redoStack.length > 0 });
    }
  }

  clearRedo(): void {
    if (this.redoStack.length === 0) return;
    this.redoStack = [];
    this.setState({ canRedo: false });
  }

  private turnsFrom(
    history: readonly ChatHistoryItem[],
    fromIndex: number,
  ): TurnSnapshot[] {
    const turns: TurnSnapshot[] = [];
    for (let i = fromIndex; i < history.length; i++) {
      const turn = this.turnSnapshot(history[i]);
      if (turn) turns.push(turn);
    }
    return turns;
  }

  private turnSnapshot(
    item: ChatHistoryItem | undefined,
  ): TurnSnapshot | undefined {
    if (!item || item.message.role !== "user" || !this.snapshotter) {
      return undefined;
    }
    const root = item.checkpoint?.roots.find(
      (r) => r.root === this.snapshotter?.toplevel,
    );
    return root
      ? {
          start: root.start,
          end: root.end,
          files: root.files,
          written: root.written,
        }
      : undefined;
  }

  private requireSnapshotter(): Snapshotter {
    if (!this.snapshotter) {
      throw new Error(
        `Undo is off: ${describeReason(this.currentState.reason)}`,
      );
    }
    return this.snapshotter;
  }
}

export function describeReason(reason: string | undefined): string {
  switch (reason) {
    case "not-a-git-repo":
      return "this folder isn't a git repository";
    case "git-not-found":
      return "git isn't installed";
    case "git-too-old":
      return "git 2.26 or later is needed";
    case "starting":
      return "snapshots are still being set up; try again in a moment";
    case "off":
      return "snapshots are turned off (--no-snapshots or NEXTCLI_SNAPSHOTS=0)";
    default:
      return "snapshots couldn't be set up";
  }
}
