/**
 * Snapshot data stored on the user message of an agent turn. It is saved with
 * the session, so undo still works after `cn --resume` or a reload of the
 * extension.
 */
export interface TurnCheckpoint {
  v: 1;
  /** One entry per work tree; the extension can have several folders open. */
  roots: TurnCheckpointRoot[];
}

export interface TurnCheckpointRoot {
  /** Absolute path of the work tree (the top level of the git repository). */
  root: string;
  /** Tree captured before the turn ran any tool. */
  start: string;
  /** Tree captured when the turn ended. Missing if the turn never finished. */
  end?: string;
  /** Paths, relative to `root`, that changed between `start` and `end`. */
  files?: string[];
}

/** The part of a checkpoint that a single snapshotter works with. */
export interface TurnSnapshot {
  start: string;
  end?: string;
  files?: string[];
}

export type DisabledReason =
  | "not-a-git-repo"
  | "git-not-found"
  | "git-too-old"
  | "error";

export interface RestoreTarget {
  /** Path relative to the work tree, with `/` separators. */
  path: string;
  /** Tree whose version of `path` is restored. Absent in it means delete. */
  tree: string;
}

export interface RevertPlan {
  targets: RestoreTarget[];
  /** Files that will be written back. */
  restore: string[];
  /** Files that will be deleted, because they didn't exist before. */
  delete: string[];
  /**
   * Files changed since the agent last wrote them, by the person or another
   * tool. Undo overwrites them, so show them before asking to confirm.
   */
  conflicts: string[];
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  /** Deletions skipped because the path is ignored once restored. */
  keptIgnored: string[];
  /** Submodules and embedded repositories, which are never restored. */
  skipped: string[];
  /** Tree of the state before the restore; `redo` puts it back. */
  redoTree: string;
}
