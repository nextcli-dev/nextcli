import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ShadowRepo } from "./store.js";

// Code points HFS+ ignores when it compares names, so `.g\u200cit` is `.git`
// there. Git's own path checks strip the same set.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * Whether a path component names git metadata on some file system: `.git`
 * in any case, with the trailing dots and spaces Windows drops, with the code
 * points HFS+ ignores, or as its NTFS short name `git~1`.
 */
export function isGitMetadataName(component: string): boolean {
  const name = component
    .replace(HFS_IGNORABLE, "")
    .toLowerCase()
    .replace(/[. ]+$/, "");
  return name === ".git" || name === "git~1";
}

export function toPosix(file: string): string {
  return file.split(path.sep).join("/");
}

/**
 * Why undo must not write or delete `file` (relative to the work tree), or
 * undefined if it may. Covers paths outside the work tree, git metadata in
 * any component, and the snapshot store when it lives inside the work tree.
 */
export function unsafePathReason(
  repo: ShadowRepo,
  file: string,
): string | undefined {
  const full = path.resolve(repo.toplevel, file);
  const rel = path.relative(repo.toplevel, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "outside the work tree";
  }
  // Split on both separators: on Windows `\` is one, and elsewhere a name
  // with a backslash is better refused than guessed at.
  if (file.split(/[\\/]/).some(isGitMetadataName)) {
    return "git metadata";
  }
  const storeRel = repo.config.storeRel;
  if (storeRel) {
    // Compare case-insensitively: refusing too much here is harmless.
    const relPosix = toPosix(rel).toLowerCase();
    const store = storeRel.toLowerCase();
    if (relPosix === store || relPosix.startsWith(store + "/")) {
      return "inside the snapshot store";
    }
  }
  return undefined;
}

/** The absolute path of `file`, or throws if undo must not touch it. */
export function resolveSafePath(repo: ShadowRepo, file: string): string {
  const reason = unsafePathReason(repo, file);
  if (reason) {
    throw new Error(`Refusing to touch a path ${reason}: ${file}`);
  }
  return path.resolve(repo.toplevel, file);
}

/**
 * Whether every folder between the work tree and `file` is a real directory.
 * A symlinked folder means the path is not in the work tree as git sees it,
 * and following it could reach files outside.
 */
export async function hasRealParents(
  repo: ShadowRepo,
  file: string,
): Promise<boolean> {
  const parts = toPosix(file).split("/").slice(0, -1);
  let dir = repo.toplevel;
  for (const part of parts) {
    dir = path.join(dir, part);
    const stat = await fs.lstat(dir).catch(() => undefined);
    if (!stat?.isDirectory()) return false;
  }
  return true;
}

/**
 * What the work tree has at `file` without following any symlinked parent:
 * a file (or symlink), a directory, or nothing.
 */
export async function workTreeEntry(
  repo: ShadowRepo,
  file: string,
): Promise<"file" | "directory" | "none"> {
  if (!(await hasRealParents(repo, file))) return "none";
  const stat = await fs
    .lstat(path.resolve(repo.toplevel, file))
    .catch(() => undefined);
  if (!stat) return "none";
  return stat.isDirectory() ? "directory" : "file";
}

/**
 * `file` relative to the work tree with `/` separators, or undefined if it is
 * outside. Accepts absolute paths, including ones through a symlinked or
 * differently cased folder.
 */
export async function workTreeRelative(
  repo: ShadowRepo,
  file: string,
): Promise<string | undefined> {
  let full = path.resolve(repo.toplevel, file);
  const dir = await fs.realpath(path.dirname(full)).catch(() => undefined);
  if (dir) full = path.join(dir, path.basename(full));
  const rel = path.relative(repo.toplevel, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return toPosix(rel);
}
