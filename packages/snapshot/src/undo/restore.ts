import { promises as fs } from "node:fs";
import * as path from "node:path";

import { splitNul } from "../git/runGit.js";
import { captureTree } from "../snapshot/capture.js";
import type { ShadowRepo, TreeEntry } from "../snapshot/store.js";
import type { RestoreResult, RestoreTarget } from "../types.js";

import { groupByTree } from "./plan.js";

/**
 * Puts each target path back to its version in the target tree, deleting it
 * if the tree doesn't have it. Used for undo and, with the redo tree, for
 * redo. Fails before changing any file if a needed object is missing.
 * The caller holds the store lock.
 */
export async function restoreFiles(
  repo: ShadowRepo,
  targets: readonly RestoreTarget[],
): Promise<RestoreResult> {
  for (const target of targets) resolveInside(repo, target.path);
  const redoTree = await captureTree(repo, `redo/${Date.now()}-${process.pid}`);

  const present = new Map<string, TreeEntry[]>();
  const absent: string[] = [];
  const skipped: string[] = [];
  for (const [tree, files] of groupByTree(
    new Map(targets.map((t) => [t.path, t.tree])),
  )) {
    const entries = await repo.lsTree(tree, files);
    const restorable: TreeEntry[] = [];
    for (const file of files) {
      const entry = entries.get(file);
      if (!entry) absent.push(file);
      else if (entry.type === "commit") skipped.push(file);
      else restorable.push(entry);
    }
    present.set(tree, restorable);
  }

  await assertObjectsExist(
    repo,
    [...present.values()].flat().map((entry) => entry.object),
  );

  const restored: string[] = [];
  for (const [tree, entries] of present) {
    if (entries.length === 0) continue;
    const paths = entries.map((entry) => entry.path);
    await repo.git(
      ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"],
      { input: paths.join("\0") },
    );
    restored.push(...paths);
  }

  // `.gitignore` files are back to their old version now, so this sees the
  // rules from before the undone turns.
  const ignored = await checkIgnored(repo, absent);
  const deleted: string[] = [];
  const keptIgnored: string[] = [];
  for (const file of absent) {
    if (ignored.has(file)) {
      keptIgnored.push(file);
      continue;
    }
    const full = resolveInside(repo, file);
    const stat = await fs.lstat(full).catch(() => undefined);
    if (stat && !stat.isDirectory()) {
      await fs.rm(full, { force: true });
      await removeEmptyParents(repo, full);
    }
    deleted.push(file);
  }

  return {
    restored: restored.sort(),
    deleted: deleted.sort(),
    keptIgnored: keptIgnored.sort(),
    skipped: skipped.sort(),
    redoTree,
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

async function checkIgnored(
  repo: ShadowRepo,
  files: readonly string[],
): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  // Exit 1 means none of the paths is ignored. check-ignore reads plain paths
  // and rejects the literal-pathspec setting.
  const { GIT_LITERAL_PATHSPECS: _literal, ...env } = repo.env;
  const { stdout } = await repo.git(
    ["check-ignore", "--no-index", "-z", "--stdin"],
    { env, input: files.join("\0") + "\0", okCodes: [0, 1] },
  );
  return new Set(splitNul(stdout));
}

function resolveInside(repo: ShadowRepo, file: string): string {
  const full = path.resolve(repo.toplevel, file);
  const rel = path.relative(repo.toplevel, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch a path outside the work tree: ${file}`);
  }
  return full;
}

async function removeEmptyParents(
  repo: ShadowRepo,
  file: string,
): Promise<void> {
  let dir = path.dirname(file);
  while (dir !== repo.toplevel && dir.startsWith(repo.toplevel)) {
    try {
      await fs.rmdir(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
