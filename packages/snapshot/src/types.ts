/** Stored on the user message of an agent turn, so undo survives a resume. */
export interface TurnCheckpoint {
  v: 1;
  roots: TurnCheckpointRoot[];
}

export interface TurnCheckpointRoot {
  /** Top level of the git work tree. */
  root: string;
  start: string;
  /** Missing if the turn never finished. */
  end?: string;
  /** Relative to `root`. */
  files?: string[];
  /** Ignored paths the turn's file tools wrote (see `Snapshotter.preserve`). */
  written?: string[];
}

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
  /** Relative to the work tree, with `/` separators. */
  path: string;
  /** Absent from `tree` means delete. */
  tree: string;
  /** Delete even if ignored: the turn wrote it, not just uncovered it. */
  written?: boolean;
}

export interface RevertPlan {
  targets: RestoreTarget[];
  restore: string[];
  delete: string[];
  /** Changed after the agent wrote them, or from an unfinished turn. */
  conflicts: string[];
  /** Submodules, git metadata and the snapshot store; not in `targets`. */
  skipped: string[];
}

export interface RestoreResult {
  restored: string[];
  deleted: string[];
  keptIgnored: string[];
  skipped: string[];
  /** The state before the restore, for redo. */
  redoTree: string;
}
