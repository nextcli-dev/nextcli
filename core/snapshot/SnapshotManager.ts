import { randomUUID } from "node:crypto";

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

/** Keeps a snapshot until it is pruned; the name only has to be unique. */
function newPin(kind: "start" | "end"): string {
  return `${Date.now()}-${randomUUID().slice(0, 8)}/${kind}`;
}

export interface SnapshotRoots {
  /** Empty when undo is off. */
  roots: { root: string; tree: string }[];
}

export interface SnapshotRevertPlan {
  roots: { root: string; plan: RevertPlan }[];
}

export interface SnapshotRestoreRequest {
  roots: { root: string; targets: RestoreTarget[] }[];
}

export interface SnapshotRestoreResult {
  /** A failed root is the last entry, with `error`; later roots are skipped. */
  roots: { root: string; result?: RestoreResult; error?: string }[];
}

/** One snapshotter per local git work tree open in the IDE. */
export class SnapshotManager {
  private readonly opened = new Map<string, Promise<OpenSnapshotterResult>>();

  constructor(
    private readonly getWorkspaceDirs: () => Promise<string[]>,
    private readonly storeRoot: () => string = getSnapshotsPath,
  ) {}

  async capture(): Promise<SnapshotRoots> {
    const snapshotters = await this.snapshotters();
    const pin = newPin("start");
    const roots = await Promise.all(
      snapshotters.map(async (s) => ({
        root: s.toplevel,
        tree: await s.capture(pin),
      })),
    );
    return { roots };
  }

  /** Before an edit tool writes `filepaths` (absolute local paths). */
  async preserve(
    checkpoint: TurnCheckpoint,
    filepaths: string[],
  ): Promise<TurnCheckpoint> {
    const byRoot = await this.byRoot();
    const pin = newPin("start");
    const roots = await Promise.all(
      checkpoint.roots.map(async (root) => {
        const snapshotter = byRoot.get(root.root);
        if (!snapshotter) return root;
        const { start, written } = await snapshotter.preserve(
          root,
          filepaths,
          pin,
        );
        return written.length > 0 ? { ...root, start, written } : root;
      }),
    );
    return { v: 1, roots };
  }

  async finishTurn(checkpoint: TurnCheckpoint): Promise<TurnCheckpoint> {
    const byRoot = await this.byRoot();
    const pin = newPin("end");
    const roots = await Promise.all(
      checkpoint.roots.map(async (root) => {
        const snapshotter = byRoot.get(root.root);
        if (!snapshotter) return root;
        const { end, files } = await snapshotter.finishTurn(
          root.start,
          pin,
          root.written,
        );
        return { ...root, end, files };
      }),
    );
    return { v: 1, roots };
  }

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
            result.snapshotter.prune().catch(() => {});
          } else {
            // Retry later: the folder may become a repository
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
