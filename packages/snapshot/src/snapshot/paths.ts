import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ShadowRepo } from "./store.js";

// HFS+ ignores these in names (`.g\u200cit` is `.git`); git strips the same set
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/** `.git` in any spelling a file system accepts, including `git~1`. */
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

/** Why undo must not touch `file`, or undefined if it may. */
export function unsafePathReason(
  repo: ShadowRepo,
  file: string,
): string | undefined {
  const full = path.resolve(repo.toplevel, file);
  const rel = path.relative(repo.toplevel, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    return "outside the work tree";
  }
  if (file.split(/[\\/]/).some(isGitMetadataName)) {
    return "git metadata";
  }
  const storeRel = repo.config.storeRel;
  if (storeRel) {
    // Case-insensitive: refusing too much is harmless
    const relPosix = toPosix(rel).toLowerCase();
    const store = storeRel.toLowerCase();
    if (relPosix === store || relPosix.startsWith(store + "/")) {
      return "inside the snapshot store";
    }
  }
  return undefined;
}

export function resolveSafePath(repo: ShadowRepo, file: string): string {
  const reason = unsafePathReason(repo, file);
  if (reason) {
    throw new Error(`Refusing to touch a path ${reason}: ${file}`);
  }
  return path.resolve(repo.toplevel, file);
}

/** A symlinked parent folder could lead outside the work tree. */
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

/** Resolves symlinked or differently cased folders; undefined if outside. */
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
