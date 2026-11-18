import { promises as fs } from "node:fs";
import * as path from "node:path";

import { dateSegment, REF_PREFIX } from "./capture.js";
import type { ShadowRepo } from "./store.js";

/** Pinned snapshots older than this are deleted by `prune`. */
export const DEFAULT_MAX_AGE_DAYS = 30;

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRUNE_STAMP = "nextcli-last-prune";

export interface PruneOptions {
  maxAgeDays?: number;
  force?: boolean;
  now?: Date;
}

/**
 * Deletes pinned snapshots older than `maxAgeDays`, then lets git drop the
 * objects nothing refers to. Runs at most once a day unless `force`.
 * The caller holds the store lock.
 */
export async function pruneStore(
  repo: ShadowRepo,
  options: PruneOptions = {},
): Promise<{ deletedRefs: number; ran: boolean }> {
  const now = options.now ?? new Date();
  const stamp = path.join(repo.storeDir, PRUNE_STAMP);
  if (!options.force) {
    const last = Date.parse(await fs.readFile(stamp, "utf8").catch(() => ""));
    if (now.getTime() - last < PRUNE_INTERVAL_MS) {
      return { deletedRefs: 0, ran: false };
    }
  }
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cutoff = dateSegment(
    new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000),
  );
  const { stdout } = await repo.git([
    "for-each-ref",
    "--format=%(refname)",
    REF_PREFIX,
  ]);
  const expired = stdout
    .toString("utf8")
    .split("\n")
    .filter((ref) => {
      const date = ref.slice(REF_PREFIX.length).split("/")[0];
      return ref.length > 0 && date !== undefined && date < cutoff;
    });
  if (expired.length > 0) {
    await repo.git(["update-ref", "--stdin"], {
      input: expired.map((ref) => `delete ${ref}\n`).join(""),
    });
  }
  // A day of grace keeps objects that a capture in another process has
  // written but not pinned yet.
  await repo.git(["gc", "--quiet", "--prune=1.day.ago"]);
  await fs.writeFile(stamp, now.toISOString());
  return { deletedRefs: expired.length, ran: true };
}
