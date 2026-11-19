import { pinTree, syncExcludes, withWorkTreePaths } from "./capture.js";
import { hasRealParents, unsafePathReason, workTreeRelative } from "./paths.js";
import type { ShadowRepo } from "./store.js";

export interface PreservedTurn {
  start: string;
  written: string[];
}

/**
 * Before a tool writes `files`: adds ignored ones (which captures leave out,
 * e.g. `.env`) to the start tree so undo covers them. Caller holds the lock.
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
    if (!(await hasRealParents(repo, rel))) continue;
    known.add(rel);
    candidates.push(rel);
  }
  if (candidates.length === 0) return { start: turn.start, written };

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
