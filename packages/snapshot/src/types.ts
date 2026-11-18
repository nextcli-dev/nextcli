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
  /**
   * Ignored paths the turn's file tools wrote. Their bytes from before the
   * turn are in `start` (see `Snapshotter.preserve`), and undo restores or
   * deletes them even though ignore rules cover them.
   */
  written?: string[];
}

/** The part of a checkpoint that a single snapshotter works with. */
export interface TurnSnapshot {
  start: string;
  end?: string;
  files?: string[];
  written?: string[];
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
  /**
   * The turn wrote this ignored path itself, so delete it even though it is
   * ignored. Without it, an ignored path absent from `tree` is kept: a
   * `.gitignore` edit may have only uncovered it.
   */
  written?: boolean;
}

export interface RevertPlan {
  targets: RestoreTarget[];
  /** Files that will be written back. */
  restore: string[];
  /** Files that will be deleted, because they didn't exist before. */
  delete: string[];
  /**
   * Files changed since the agent last wrote them, by the person or another
   * tool, and every file of a turn that never finished (its end is unknown,
   * so a later edit can't be told apart). Undo overwrites them, so show them
   * before asking to confirm.
   */
  conflicts: string[];
  /**
   * Changed paths undo leaves alone: submodules and embedded repositories,
   * git metadata, and the snapshot store. They are not in `targets`.
   */
  skipped: string[];
}

export interface RestoreResult {
  restored: string[];
  /** Files that existed and were removed. */
  deleted: string[];
  /** Deletions skipped because the path is ignored once restored. */
  keptIgnored: string[];
  /** Submodules and embedded repositories, which are never restored. */
  skipped: string[];
  /** Tree of the state before the restore; `redo` puts it back. */
  redoTree: string;
}
