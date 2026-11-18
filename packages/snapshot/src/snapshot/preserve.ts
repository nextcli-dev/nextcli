import { pinTree, syncExcludes, withWorkTreePaths } from "./capture.js";
import { hasRealParents, unsafePathReason, workTreeRelative } from "./paths.js";
import type { ShadowRepo } from "./store.js";

export interface PreservedTurn {
  start: string;
  written: string[];
}

/**
 * Called before a tool writes `files`, so undo covers ignored files too.
 * Captures leave ignored files out, so a turn that rewrote `.env` would
 * otherwise look like it changed nothing. Each ignored path that `start`
 * doesn't hold is added to a new start tree with its current bytes (or, if
 * it doesn't exist yet, left absent so undo deletes it) and listed in
 * `written`. Paths the turn already wrote, paths that aren't ignored (a
 * capture already has them) and paths outside the work tree are skipped.
 * The caller holds the store lock.
 */
export async function preserveBeforeWrite(
  repo: ShadowRepo,
  turn: { start: string; written?: readonly string[] },
  files: readonly string[],
  pin?: string,
): Promise<PreservedTurn> {
  const written = [...(turn.written ?? [])];
  const known = new Set(written);
  const candidates: string[] = [];
  for (const file of files) {
    const rel = await workTreeRelative(repo, file);
    if (!rel || known.has(rel) || unsafePathReason(repo, rel)) continue;
    // A path under a symlinked folder isn't in the work tree as git sees it.
    if (!(await hasRealParents(repo, rel))) continue;
    known.add(rel);
    candidates.push(rel);
  }
  if (candidates.length === 0) return { start: turn.start, written };

  // The person's excludes file and the size limit may have changed since
  // the last capture.
  await syncExcludes(repo);
  const inStart = await repo.lsTree(turn.start, candidates);
  const ignored = await repo.ignored(
    candidates.filter((file) => !inStart.has(file)),
  );
  if (ignored.size === 0) return { start: turn.start, written };

  const added = [...ignored];
  const start = await withWorkTreePaths(repo, turn.start, added);
  if (pin && start !== turn.start) await pinTree(repo, start, pin);
  return { start, written: [...written, ...added] };
}
