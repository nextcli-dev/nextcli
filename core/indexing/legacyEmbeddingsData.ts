/**
 * What codebase embeddings and @docs left on disk. Both were removed in
 * 1.6.8, and nothing reads this data any more; it only saves re-embedding if
 * the user rolls back to 1.6.7 or earlier. So it is deleted only when the
 * user agrees: from a one-time notice in VS Code, the "Delete Legacy Index
 * Data" command, or `cn cleanup`.
 *
 * - `index/lancedb/`: the LanceDB vector tables (codebase and docs);
 * - `index/docs.sqlite`: @docs site metadata;
 * - in `index/index.sqlite`, the `lance_db_cache` table (vectors as JSON)
 *   and the embeddings index's rows in `tag_catalog` and `global_cache`
 *   (artifact ids `vectordb::<embedding id>`).
 */
import fs from "node:fs/promises";
import path from "node:path";

import type { IDE } from "../index.js";
import { GlobalContext } from "../util/GlobalContext.js";
import { getIndexFolderPath, getIndexSqlitePath } from "../util/paths.js";
import { SqliteDb } from "./refreshIndex.js";

const LEGACY_ARTIFACT_PREFIX = "vectordb::";
const LEGACY_FILES = [
  "lancedb",
  "docs.sqlite",
  "docs.sqlite-wal",
  "docs.sqlite-shm",
  "docs.sqlite-journal",
];

export interface LegacyEmbeddingsData {
  /** Files and folders in the index folder, with their size in bytes */
  files: { name: string; bytes: number }[];
  /** Rows of lance_db_cache, plus embeddings rows in tag_catalog/global_cache */
  indexRows: number;
  /** Approximate size of those rows in index.sqlite */
  indexBytes: number;
  totalBytes: number;
}

async function sizeOf(target: string): Promise<number> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  for (const entry of await fs.readdir(target)) {
    total += await sizeOf(path.join(target, entry));
  }
  return total;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function hasLanceDbCache() {
  const db = await SqliteDb.get();
  return !!(await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lance_db_cache'",
  ));
}

/** Finds the legacy data without changing anything; undefined if there is none */
export async function findLegacyEmbeddingsData(): Promise<
  LegacyEmbeddingsData | undefined
> {
  const indexFolder = getIndexFolderPath();
  const files: LegacyEmbeddingsData["files"] = [];
  for (const name of LEGACY_FILES) {
    const target = path.join(indexFolder, name);
    if (await exists(target)) {
      files.push({ name, bytes: await sizeOf(target) });
    }
  }

  let indexRows = 0;
  let indexBytes = 0;
  // Don't create index.sqlite just to look inside it
  if (await exists(getIndexSqlitePath())) {
    const db = await SqliteDb.get();
    if (await hasLanceDbCache()) {
      const cache = await db.get<{ rows: number; bytes: number }>(
        "SELECT count(*) AS rows, coalesce(sum(length(vector) + length(contents) + length(path)), 0) AS bytes FROM lance_db_cache",
      );
      indexRows += cache?.rows ?? 0;
      indexBytes += cache?.bytes ?? 0;
    }
    for (const table of ["tag_catalog", "global_cache"]) {
      const row = await db.get<{ rows: number }>(
        `SELECT count(*) AS rows FROM ${table} WHERE artifactId LIKE ?`,
        `${LEGACY_ARTIFACT_PREFIX}%`,
      );
      indexRows += row?.rows ?? 0;
    }
  }

  if (files.length === 0 && indexRows === 0) {
    return undefined;
  }
  const filesBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return { files, indexRows, indexBytes, totalBytes: filesBytes + indexBytes };
}

/** Deletes the legacy data and returns what was there */
export async function removeLegacyEmbeddingsData(): Promise<
  LegacyEmbeddingsData | undefined
> {
  const found = await findLegacyEmbeddingsData();
  if (!found) {
    return undefined;
  }
  const indexFolder = getIndexFolderPath();
  for (const { name } of found.files) {
    await fs.rm(path.join(indexFolder, name), {
      recursive: true,
      force: true,
    });
  }
  if (found.indexRows > 0) {
    const db = await SqliteDb.get();
    if (await hasLanceDbCache()) {
      // The freed pages stay in index.sqlite and are reused by later writes;
      // VACUUM would block the extension host while it rewrites the file
      await db.exec("DROP TABLE lance_db_cache");
    }
    for (const table of ["tag_catalog", "global_cache"]) {
      await db.run(
        `DELETE FROM ${table} WHERE artifactId LIKE ?`,
        `${LEGACY_ARTIFACT_PREFIX}%`,
      );
    }
  }
  return found;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export const LEGACY_CLEANUP_DELETE = "Delete";
export const LEGACY_CLEANUP_KEEP = "Keep";
export const LEGACY_CLEANUP_NEVER = "Don't show again";

/**
 * Offers to delete the legacy data. On start-up (`fromCommand` false) it
 * shows only when there is data and the user hasn't chosen "Don't show
 * again"; from the command it always answers, even when there is nothing.
 */
export async function offerLegacyEmbeddingsCleanup(
  ide: IDE,
  { fromCommand }: { fromCommand: boolean },
): Promise<void> {
  const globalContext = new GlobalContext();
  if (
    !fromCommand &&
    globalContext.get("hasDismissedLegacyEmbeddingsCleanup")
  ) {
    return;
  }

  const found = await findLegacyEmbeddingsData();
  if (!found) {
    if (fromCommand) {
      void ide.showToast("info", "No legacy index data found.");
    }
    return;
  }

  const buttons = [LEGACY_CLEANUP_DELETE, LEGACY_CLEANUP_KEEP];
  if (!fromCommand) {
    buttons.push(LEGACY_CLEANUP_NEVER);
  }
  const choice = await ide.showToast(
    "info",
    `NextCLI no longer uses embeddings. Old codebase index and @docs data takes ${formatBytes(found.totalBytes)} in ~/.continue/index. Delete it? Only versions 1.6.7 and earlier can use it.`,
    ...buttons,
  );

  if (choice === LEGACY_CLEANUP_DELETE) {
    await removeLegacyEmbeddingsData();
    void ide.showToast(
      "info",
      `Deleted the old index data (${formatBytes(found.totalBytes)}).`,
    );
  } else if (choice === LEGACY_CLEANUP_NEVER) {
    globalContext.update("hasDismissedLegacyEmbeddingsCleanup", true);
  }
}
