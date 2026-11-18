import { promises as fs } from "node:fs";
import * as path from "node:path";

import { captureTree } from "../snapshot/capture.js";
import { resolveSafePath, workTreeEntry } from "../snapshot/paths.js";
import type { ShadowRepo, TreeEntry } from "../snapshot/store.js";
import type { RestoreResult, RestoreTarget } from "../types.js";

import { groupByTree } from "./plan.js";

/**
 * A restore that failed after it had changed files. `redoTree` still holds
 * the state from before the restore, so the caller can offer redo; `partial`
 * says what was done.
 */
export class RestoreError extends Error {
  constructor(
    message: string,
    readonly redoTree: string,
    readonly partial: RestoreResult,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RestoreError";
  }
}

/**
 * Puts each target path back to its version in the target tree, deleting it
 * if the tree doesn't have it. Used for undo and, with the redo tree, for
 * redo. Fails before changing any file if a path is unsafe or a needed
 * object is missing; a failure after that throws a `RestoreError`.
 * The caller holds the store lock.
 */
export async function restoreFiles(
  repo: ShadowRepo,
  targets: readonly RestoreTarget[],
): Promise<RestoreResult> {
  for (const target of targets) resolveSafePath(repo, target.path);
  const written = targets.filter((t) => t.written).map((t) => t.path);
  const forceDelete = new Set(written);
  // Ignored files the turns wrote go into the redo tree too, or redo
  // couldn't bring them back.
  const redoTree = await captureTree(
    repo,
    `redo/${Date.now()}-${process.pid}`,
    written,
  );
  const result: RestoreResult = {
    restored: [],
    deleted: [],
    keptIgnored: [],
    skipped: [],
    redoTree,
  };

  const present = new Map<string, TreeEntry[]>();
  const absent: string[] = [];
  for (const [tree, files] of groupByTree(
    new Map(targets.map((t) => [t.path, t.tree])),
  )) {
    const entries = await repo.lsTree(tree, files);
    const restorable: TreeEntry[] = [];
    for (const file of files) {
      const entry = entries.get(file);
      if (!entry) absent.push(file);
      else if (entry.type === "commit") result.skipped.push(file);
      else restorable.push(entry);
    }
    present.set(tree, restorable);
  }

  await assertObjectsExist(
    repo,
    [...present.values()].flat().map((entry) => entry.object),
  );

  try {
    for (const [tree, entries] of present) {
      if (entries.length === 0) continue;
      const paths = entries.map((entry) => entry.path);
      await repo.git(
        ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"],
        { input: paths.join("\0") },
      );
      result.restored.push(...paths);
    }

    // Only files that are still there, under real folders, can be deleted.
    // A path under a folder the checkout turned back into a symlink is gone
    // from the work tree, and following the link could reach outside it.
    const deletable: string[] = [];
    for (const file of absent) {
      if ((await workTreeEntry(repo, file)) === "file") deletable.push(file);
    }
    // `.gitignore` files are back to their old version now, so this sees
    // the rules from before the undone turns.
    const ignored = await repo.ignored(
      deletable.filter((file) => !forceDelete.has(file)),
    );
    for (const file of deletable) {
      if (ignored.has(file)) {
        result.keptIgnored.push(file);
        continue;
      }
      // Check again right before the unlink; nothing should have changed,
      // but this is the step that can't be taken back.
      if ((await workTreeEntry(repo, file)) !== "file") continue;
      const full = resolveSafePath(repo, file);
      await fs.rm(full, { force: true });
      await removeEmptyParents(repo, full);
      result.deleted.push(file);
    }
  } catch (error) {
    throw new RestoreError(
      `The restore stopped partway: ${(error as Error).message}`,
      redoTree,
      sorted(result),
      { cause: error },
    );
  }
  return sorted(result);
}

function sorted(result: RestoreResult): RestoreResult {
  return {
    restored: [...result.restored].sort(),
    deleted: [...result.deleted].sort(),
    keptIgnored: [...result.keptIgnored].sort(),
    skipped: [...result.skipped].sort(),
    redoTree: result.redoTree,
  };
}

async function assertObjectsExist(
  repo: ShadowRepo,
  objects: readonly string[],
): Promise<void> {
  if (objects.length === 0) return;
  const { stdout } = await repo.git(["cat-file", "--batch-check"], {
    input: objects.join("\n") + "\n",
  });
  const missing = stdout
    .toString("utf8")
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.split(" ")[0]);
  if (missing.length > 0) {
    throw new Error(
      `Snapshot objects are missing (${missing.length}), so no file was changed. ` +
        `The project's git may have pruned them. First missing: ${missing[0]}`,
    );
  }
}

async function removeEmptyParents(
  repo: ShadowRepo,
  file: string,
): Promise<void> {
  let dir = path.dirname(file);
  while (dir !== repo.toplevel && dir.startsWith(repo.toplevel + path.sep)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
