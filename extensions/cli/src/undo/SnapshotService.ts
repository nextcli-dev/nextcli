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
  reason?: string;
  root?: string;
  canRedo: boolean;
}

export interface SnapshotServiceOptions {
  enabled: boolean;
  cwd?: string;
  storeRoot?: string;
}

export interface UndoPlan {
  fromIndex: number;
  turns: number;
  plan: RevertPlan;
}

interface RedoEntry {
  targets: RestoreTarget[];
  /** Messages the undo removed. */
  removedHistory?: ChatHistoryItem[];
}

export interface OpenTurn {
  start: string;
  pinPrefix: string;
  written: string[];
}

/** Only the terminal UI: never `-p`, `cn serve` or `cn review`. */
export function shouldSnapshot(
  options: { headless?: boolean; snapshots?: boolean },
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = environment.NEXTCLI_SNAPSHOTS?.trim().toLowerCase();
  const offByEnv = value === "0" || value === "false" || value === "off";
  return !options.headless && options.snapshots !== false && !offByEnv;
}

export class SnapshotService extends BaseService<SnapshotServiceState> {
  private snapshotter: Snapshotter | undefined;
  private redoStack: RedoEntry[] = [];
  private opening: Promise<void> = Promise.resolve();
  private background: Promise<unknown> = Promise.resolve();
  /** One at a time: each preserve extends the turn's start. */
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
    // In the background, so startup never waits for git
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
      // The first capture hashes the whole tree; don't make a turn wait
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

  async settled(): Promise<void> {
    await this.opening;
    await this.background;
  }

  /** Undefined if off or failed. Also makes the last undo final. */
  async beginTurn(
    sessionId: string,
    existing?: TurnCheckpoint,
  ): Promise<{ checkpoint: TurnCheckpoint; turn: OpenTurn } | undefined> {
    await this.opening;
    const snapshotter = this.snapshotter;
    if (!snapshotter) return undefined;
    this.clearRedo();
    // A resumed turn keeps its first start
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

  /** Before a file tool writes; returns the checkpoint if it changed. */
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

  lastUndoableIndex(history: readonly ChatHistoryItem[]): number | undefined {
    for (let i = history.length - 1; i >= 0; i--) {
      if (this.turnSnapshot(history[i])) return i;
    }
    return undefined;
  }

  canRestore(history: readonly ChatHistoryItem[], index: number): boolean {
    return !!this.turnSnapshot(history[index]);
  }

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
      if (error instanceof RestoreError) pushRedo(error.redoTree);
      throw error;
    }
  }

  async redo(): Promise<
    { result: RestoreResult; removedHistory?: ChatHistoryItem[] } | undefined
  > {
    const snapshotter = this.requireSnapshotter("Redo");
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

  offMessage(action: "Undo" | "Redo"): string {
    return `${action} is off: ${describeReason(this.currentState.reason)}.`;
  }

  private requireSnapshotter(action: "Undo" | "Redo" = "Undo"): Snapshotter {
    if (!this.snapshotter) throw new Error(this.offMessage(action));
    return this.snapshotter;
  }
}

function describeReason(reason: string | undefined): string {
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
