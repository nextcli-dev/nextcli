import { promises as fs } from "node:fs";
import * as path from "node:path";

import { cleanEnv, parseGitVersion, runGit } from "../git/runGit.js";
import type {
  DisabledReason,
  RestoreResult,
  RestoreTarget,
  RevertPlan,
  TurnSnapshot,
} from "../types.js";
import { planRevert } from "../undo/plan.js";
import { restoreFiles } from "../undo/restore.js";

import { captureTree } from "./capture.js";
import { pruneStore, type PruneOptions } from "./prune.js";
import { ShadowRepo, storeKey } from "./store.js";

/** Untracked files above this size are left out of snapshots. */
export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;

const MIN_GIT: [number, number] = [2, 26];

export interface OpenSnapshotterOptions {
  /** Any directory inside the work tree. */
  cwd: string;
  /** Directory that holds one store per work tree, e.g. `~/.continue/snapshots`. */
  storeRoot: string;
  gitBinary?: string;
  maxUntrackedFileBytes?: number;
  /** Defaults to `process.env`. Inherited `GIT_*` variables are dropped. */
  env?: NodeJS.ProcessEnv;
}

export type OpenSnapshotterResult =
  | { ok: true; snapshotter: Snapshotter }
  | { ok: false; reason: DisabledReason; detail?: string };

/**
 * Opens (and creates on first use) the shadow repository for the git work
 * tree that contains `cwd`. Folders outside a git repository get no
 * snapshots.
 */
export async function openSnapshotter(
  options: OpenSnapshotterOptions,
): Promise<OpenSnapshotterResult> {
  const gitBinary = options.gitBinary ?? "git";
  const baseEnv = cleanEnv(options.env ?? process.env);

  let versionOutput: string;
  try {
    versionOutput = (
      await runGit(gitBinary, ["--version"], { env: baseEnv })
    ).stdout.toString("utf8");
  } catch (error) {
    return {
      ok: false,
      reason: "git-not-found",
      detail: (error as Error).message,
    };
  }
  const version = parseGitVersion(versionOutput);
  if (
    !version ||
    version[0] < MIN_GIT[0] ||
    (version[0] === MIN_GIT[0] && version[1] < MIN_GIT[1])
  ) {
    return { ok: false, reason: "git-too-old", detail: versionOutput.trim() };
  }

  let toplevel: string;
  let gitDir: string;
  let commonDir: string;
  try {
    const out = (
      await runGit(
        gitBinary,
        ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
        { env: baseEnv, cwd: options.cwd },
      )
    ).stdout
      .toString("utf8")
      .split(/\r?\n/);
    if (!out[0] || !out[1] || !out[2]) throw new Error("no work tree");
    toplevel = await fs.realpath(out[0]);
    gitDir = path.resolve(options.cwd, out[1]);
    commonDir = path.resolve(options.cwd, out[2]);
  } catch (error) {
    return {
      ok: false,
      reason: "not-a-git-repo",
      detail: (error as Error).message,
    };
  }

  try {
    const repo = new ShadowRepo({
      gitBinary,
      baseEnv,
      toplevel,
      projectGitDir: gitDir,
      projectCommonDir: commonDir,
      storeRoot: path.resolve(options.storeRoot),
      storeDir: path.join(options.storeRoot, storeKey(toplevel)),
      maxUntrackedFileBytes:
        options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES,
    });
    await repo.init();
    return { ok: true, snapshotter: new Snapshotter(repo) };
  } catch (error) {
    return { ok: false, reason: "error", detail: (error as Error).message };
  }
}

/**
 * Snapshots of one git work tree, and undo and redo between them. Every
 * operation holds the store lock, so two processes sharing a store never
 * interleave.
 */
export class Snapshotter {
  readonly toplevel: string;
  readonly storeDir: string;

  constructor(private readonly repo: ShadowRepo) {
    this.toplevel = repo.toplevel;
    this.storeDir = repo.storeDir;
  }

  /**
   * Records the current state of the work tree and returns its tree id.
   * With `pin`, the tree is kept by `refs/cn/<date>/<pin>` until `prune`
   * removes it.
   */
  capture(pin?: string): Promise<string> {
    return this.repo.lock.run(() => captureTree(this.repo, pin));
  }

  /** Paths, relative to the work tree, that differ between two trees. */
  changedFiles(from: string, to: string): Promise<string[]> {
    return this.repo.changedFiles(from, to);
  }

  /** Captures the end of a turn and lists the files it changed. */
  async finishTurn(
    start: string,
    pin?: string,
  ): Promise<{ end: string; files: string[] }> {
    const end = await this.capture(pin);
    return { end, files: await this.changedFiles(start, end) };
  }

  /** See `undo/plan.ts`. */
  planRevert(turns: readonly TurnSnapshot[]): Promise<RevertPlan> {
    return this.repo.lock.run(() => planRevert(this.repo, turns));
  }

  /** See `undo/restore.ts`. */
  restore(targets: readonly RestoreTarget[]): Promise<RestoreResult> {
    return this.repo.lock.run(() => restoreFiles(this.repo, targets));
  }

  /** See `snapshot/prune.ts`. */
  prune(
    options: PruneOptions = {},
  ): Promise<{ deletedRefs: number; ran: boolean }> {
    return this.repo.lock.run(() => pruneStore(this.repo, options));
  }
}
