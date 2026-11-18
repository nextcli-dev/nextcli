import { captureTree } from "../snapshot/capture.js";
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
  const current = await captureTree(repo);
  const target = new Map<string, string>();
  const lastEnd = new Map<string, string>();
  for (const [index, turn] of turns.entries()) {
    // A turn that never finished ends where the next one starts, or now.
    const end = turn.end ?? turns[index + 1]?.start ?? current;
    const files = turn.files ?? (await repo.changedFiles(turn.start, end));
    for (const file of files) {
      if (!target.has(file)) target.set(file, turn.start);
      lastEnd.set(file, end);
    }
  }

  const conflicts: string[] = [];
  for (const [end, files] of groupByTree(lastEnd)) {
    const changed = new Set(await repo.changedFiles(end, current));
    conflicts.push(...files.filter((file) => changed.has(file)));
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
    targets: [...target].map(([file, tree]) => ({ path: file, tree })),
    restore: restore.sort(),
    delete: remove.sort(),
    conflicts: conflicts.sort(),
  };
}
