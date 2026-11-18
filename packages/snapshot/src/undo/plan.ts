import { captureTree } from "../snapshot/capture.js";
import { unsafePathReason } from "../snapshot/paths.js";
import type { ShadowRepo } from "../snapshot/store.js";
import type { RevertPlan, TurnSnapshot } from "../types.js";

/** Groups a `file → tree` map by tree. */
export function groupByTree(map: Map<string, string>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [file, tree] of map) {
    const list = groups.get(tree);
    if (list) list.push(file);
    else groups.set(tree, [file]);
  }
  return groups;
}

/**
 * Works out how to undo `turns` (oldest first): each file the turns changed
 * goes back to its version at the start of the earliest turn that touched
 * it, and files someone changed after the agent did are reported.
 * The caller holds the store lock.
 */
export async function planRevert(
  repo: ShadowRepo,
  turns: readonly TurnSnapshot[],
): Promise<RevertPlan> {
  const written = new Set(turns.flatMap((turn) => turn.written ?? []));
  const current = await captureTree(repo, undefined, [...written]);
  const target = new Map<string, string>();
  const lastEnd = new Map<string, string>();
  const unfinished = new Set<string>();
  for (const [index, turn] of turns.entries()) {
    // A turn that never finished ends where the next one starts, or now.
    const end = turn.end ?? turns[index + 1]?.start ?? current;
    const files = new Set([
      ...(turn.files ?? (await repo.changedFiles(turn.start, end))),
      ...(turn.written ?? []),
    ]);
    for (const file of files) {
      if (!target.has(file)) target.set(file, turn.start);
      lastEnd.set(file, end);
      if (!turn.end) unfinished.add(file);
    }
  }

  const skipped = new Set<string>();
  for (const file of target.keys()) {
    if (unsafePathReason(repo, file)) skipped.add(file);
  }
  // Undo never moves a submodule or an embedded repository, whichever side
  // of the change has it.
  for (const [tree, files] of groupByTree(target)) {
    await addGitlinks(repo, tree, files, skipped);
  }
  await addGitlinks(repo, current, [...target.keys()], skipped);
  for (const file of skipped) {
    target.delete(file);
    lastEnd.delete(file);
  }

  // A turn without an end can't say which edits were the agent's, so all of
  // its files need confirming.
  const conflicts = new Set([...unfinished].filter((f) => target.has(f)));
  for (const [end, files] of groupByTree(lastEnd)) {
    const changed = new Set(await repo.changedFiles(end, current));
    for (const file of files) if (changed.has(file)) conflicts.add(file);
  }

  const restore: string[] = [];
  const remove: string[] = [];
  for (const [tree, files] of groupByTree(target)) {
    const present = await repo.lsTree(tree, files);
    for (const file of files) {
      (present.has(file) ? restore : remove).push(file);
    }
  }
  return {
    targets: [...target].map(([file, tree]) =>
      written.has(file)
        ? { path: file, tree, written: true }
        : { path: file, tree },
    ),
    restore: restore.sort(),
    delete: remove.sort(),
    conflicts: [...conflicts].sort(),
    skipped: [...skipped].sort(),
  };
}

async function addGitlinks(
  repo: ShadowRepo,
  tree: string,
  files: readonly string[],
  into: Set<string>,
): Promise<void> {
  const safe = files.filter((file) => !into.has(file));
  for (const [file, entry] of await repo.lsTree(tree, safe)) {
    if (entry.type === "commit") into.add(file);
  }
}
