import {
  openSnapshotter,
  RestoreError,
  type OpenSnapshotterResult,
  type RestoreResult,
  type RestoreTarget,
  type RevertPlan,
  type Snapshotter,
  type TurnCheckpoint,
  type TurnSnapshot,
} from "@nextcli/snapshot";

import { getSnapshotsPath } from "../util/paths";
import { localPathOrUriToPath } from "../util/pathToUri";

export interface SnapshotRoots {
  /** One tree per git work tree in the workspace. Empty when undo is off. */
  roots: { root: string; tree: string }[];
}

export interface SnapshotRevertPlan {
  roots: { root: string; plan: RevertPlan }[];
}

export interface SnapshotRestoreRequest {
  roots: { root: string; targets: RestoreTarget[] }[];
}

export interface SnapshotRestoreResult {
  /**
   * One entry per work tree restored, in request order. A restore that
   * failed is the last entry, with `error`; it has a `result` (with the redo
   * tree) only if it changed files before it failed. Later roots are not
   * attempted.
   */
  roots: { root: string; result?: RestoreResult; error?: string }[];
}

/**
 * Snapshots every git work tree open in the IDE, so the extension can undo
 * and redo agent turns. Folders outside git and remote (non-file) folders
 * are left out.
 */
export class SnapshotManager {
  private readonly opened = new Map<string, Promise<OpenSnapshotterResult>>();

  constructor(
    private readonly getWorkspaceDirs: () => Promise<string[]>,
    private readonly storeRoot: () => string = getSnapshotsPath,
  ) {}

  async capture(pin?: string): Promise<SnapshotRoots> {
    const snapshotters = await this.snapshotters();
    const roots = await Promise.all(
      snapshotters.map(async (s) => ({
        root: s.toplevel,
        tree: await s.capture(pin ? `${pin}/start` : undefined),
      })),
    );
    return { roots };
  }

  /**
   * Called before an edit tool writes `filepaths` (absolute local paths).
   * Saves the ignored ones, which snapshots leave out, into each work
   * tree's start, so undo covers them. Returns the updated checkpoint.
   */
  async preserve(
    checkpoint: TurnCheckpoint,
    filepaths: string[],
    pin?: string,
  ): Promise<TurnCheckpoint> {
    const byRoot = await this.byRoot();
    const roots = await Promise.all(
      checkpoint.roots.map(async (root) => {
        const snapshotter = byRoot.get(root.root);
        if (!snapshotter) return root;
        const { start, written } = await snapshotter.preserve(
          root,
          filepaths,
          pin ? `${pin}/start` : undefined,
        );
        return written.length > 0 ? { ...root, start, written } : root;
      }),
    );
    return { v: 1, roots };
  }

  /** Captures the end of a turn and the files it changed, per work tree. */
  async finishTurn(
    checkpoint: TurnCheckpoint,
    pin?: string,
  ): Promise<TurnCheckpoint> {
    const byRoot = await this.byRoot();
    const roots = await Promise.all(
      checkpoint.roots.map(async (root) => {
        const snapshotter = byRoot.get(root.root);
        if (!snapshotter) return root;
        const { end, files } = await snapshotter.finishTurn(
          root.start,
          pin ? `${pin}/end` : undefined,
          root.written,
        );
        return { ...root, end, files };
      }),
    );
    return { v: 1, roots };
  }

  /** Plans undoing these turns (oldest first) in every work tree. */
  async planRevert(
    checkpoints: readonly TurnCheckpoint[],
  ): Promise<SnapshotRevertPlan> {
    const turnsByRoot = new Map<string, TurnSnapshot[]>();
    for (const checkpoint of checkpoints) {
      for (const root of checkpoint.roots) {
        const turns = turnsByRoot.get(root.root) ?? [];
        turns.push({
          start: root.start,
          end: root.end,
          files: root.files,
          written: root.written,
        });
        turnsByRoot.set(root.root, turns);
      }
    }
    const byRoot = await this.byRoot();
    const roots: SnapshotRevertPlan["roots"] = [];
    for (const [root, turns] of turnsByRoot) {
      const snapshotter = byRoot.get(root);
      if (!snapshotter) {
        throw new Error(`${root} is no longer open, so it can't be restored.`);
      }
      roots.push({ root, plan: await snapshotter.planRevert(turns) });
    }
    return { roots };
  }

  /**
   * Restores files; used for undo and, with the redo trees, for redo. Stops
   * at the first work tree that fails and reports it, so the caller can
   * still offer redo for what was changed.
   */
  async restore(
    request: SnapshotRestoreRequest,
  ): Promise<SnapshotRestoreResult> {
    const byRoot = await this.byRoot();
    for (const { root } of request.roots) {
      if (!byRoot.has(root)) {
        throw new Error(`${root} is no longer open, so it can't be restored.`);
      }
    }
    const roots: SnapshotRestoreResult["roots"] = [];
    for (const { root, targets } of request.roots) {
      try {
        roots.push({ root, result: await byRoot.get(root)!.restore(targets) });
      } catch (error) {
        roots.push({
          root,
          result: error instanceof RestoreError ? error.partial : undefined,
          error: (error as Error).message,
        });
        break;
      }
    }
    return { roots };
  }

  private async byRoot(): Promise<Map<string, Snapshotter>> {
    const snapshotters = await this.snapshotters();
    return new Map(snapshotters.map((s) => [s.toplevel, s]));
  }

  private async snapshotters(): Promise<Snapshotter[]> {
    const dirs = (await this.getWorkspaceDirs())
      .filter((dir) => !dir.includes("://") || dir.startsWith("file://"))
      .map(localPathOrUriToPath);
    const results = await Promise.all(dirs.map((dir) => this.open(dir)));
    // Two folders of the same repository share one snapshotter.
    const unique = new Map<string, Snapshotter>();
    for (const result of results) {
      if (result.ok && !unique.has(result.snapshotter.toplevel)) {
        unique.set(result.snapshotter.toplevel, result.snapshotter);
      }
    }
    return [...unique.values()];
  }

  private open(dir: string): Promise<OpenSnapshotterResult> {
    let opened = this.opened.get(dir);
    if (!opened) {
      opened = openSnapshotter({ cwd: dir, storeRoot: this.storeRoot() }).then(
        (result) => {
          if (result.ok) {
            // Drop snapshots older than the retention period, at most daily.
            result.snapshotter.prune().catch(() => {});
          } else {
            // Try again next time: the folder may become a repository.
            this.opened.delete(dir);
          }
          return result;
        },
      );
      this.opened.set(dir, opened);
    }
    return opened;
  }
}
