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
import { isOutside, toPosix } from "./paths.js";
import { preserveBeforeWrite, type PreservedTurn } from "./preserve.js";
import { pruneStore, type PruneOptions } from "./prune.js";
import { ShadowRepo, storeKey } from "./store.js";

export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;

const MIN_GIT: [number, number] = [2, 26];

export interface OpenSnapshotterOptions {
  cwd: string;
  /** One store per work tree under it, e.g. `~/.continue/snapshots`. */
  storeRoot: string;
  gitBinary?: string;
  maxUntrackedFileBytes?: number;
  /** Inherited `GIT_*` variables are dropped. */
  env?: NodeJS.ProcessEnv;
}

export type OpenSnapshotterResult =
  | { ok: true; snapshotter: Snapshotter }
  | { ok: false; reason: DisabledReason; detail?: string };

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
    // Real paths on both sides, or a store inside the work tree that is
    // reached through a symlink or another case would go unnoticed
    const requestedRoot = path.resolve(options.cwd, options.storeRoot);
    await fs.mkdir(requestedRoot, { recursive: true });
    const storeRoot = await fs.realpath(requestedRoot);
    const rel = path.relative(toplevel, storeRoot);
    const storeRel = isOutside(rel) ? undefined : toPosix(rel);
    const repo = new ShadowRepo({
      gitBinary,
      baseEnv,
      toplevel,
      projectGitDir: gitDir,
      projectCommonDir: commonDir,
      storeDir: path.join(storeRoot, storeKey(toplevel)),
      storeRel,
      maxUntrackedFileBytes:
        options.maxUntrackedFileBytes ?? DEFAULT_MAX_UNTRACKED_FILE_BYTES,
    });
    await repo.init();
    return { ok: true, snapshotter: new Snapshotter(repo) };
  } catch (error) {
    return { ok: false, reason: "error", detail: (error as Error).message };
  }
}

export class Snapshotter {
  readonly toplevel: string;
  readonly storeDir: string;

  constructor(private readonly repo: ShadowRepo) {
    this.toplevel = repo.toplevel;
    this.storeDir = repo.storeDir;
  }

  /** `pin` keeps the tree (`refs/cn/<date>/<pin>`) until it is pruned. */
  capture(pin?: string): Promise<string> {
    return this.repo.lock.run(() => captureTree(this.repo, pin));
  }

  changedFiles(from: string, to: string): Promise<string[]> {
    return this.repo.changedFiles(from, to);
  }

  /** Call before a tool writes `files`; store the result on the checkpoint. */
  preserve(
    turn: { start: string; written?: readonly string[] },
    files: readonly string[],
    pin?: string,
  ): Promise<PreservedTurn> {
    return this.repo.lock.run(() =>
      preserveBeforeWrite(this.repo, turn, files, pin),
    );
  }

  async finishTurn(
    start: string,
    pin?: string,
    written: readonly string[] = [],
  ): Promise<{ end: string; files: string[] }> {
    const end = await this.repo.lock.run(() =>
      captureTree(this.repo, pin, written),
    );
    return { end, files: await this.changedFiles(start, end) };
  }

  planRevert(turns: readonly TurnSnapshot[]): Promise<RevertPlan> {
    return this.repo.lock.run(() => planRevert(this.repo, turns));
  }

  restore(targets: readonly RestoreTarget[]): Promise<RestoreResult> {
    return this.repo.lock.run(() => restoreFiles(this.repo, targets));
  }

  prune(
    options: PruneOptions = {},
  ): Promise<{ deletedRefs: number; ran: boolean }> {
    return this.repo.lock.run(() => pruneStore(this.repo, options));
  }
}
