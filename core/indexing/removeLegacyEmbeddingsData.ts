/**
 * Removes what codebase embeddings and @docs left on disk. Both were removed
 * in 1.6.8; until then their data was kept so a rollback still found it:
 * - `index/lancedb/`: the LanceDB vector tables (codebase and docs);
 * - `index/docs.sqlite`: @docs site metadata;
 * - in `index/index.sqlite`, the `lance_db_cache` table (vectors as JSON)
 *   and the embeddings index's rows in `tag_catalog` and `global_cache`
 *   (artifact ids `vectordb::<embedding id>`).
 *
 * Idempotent: it runs on every start and finds nothing once done, so it also
 * cleans up after a rollback to an older release and back.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { getIndexFolderPath } from "../util/paths";
import { SqliteDb } from "./refreshIndex";

const LEGACY_ARTIFACT_PREFIX = "vectordb::";

export interface LegacyEmbeddingsCleanup {
  /** Files and folders removed, relative to the index folder */
  removed: string[];
  /** Rows removed from tag_catalog and global_cache */
  rowsRemoved: number;
  droppedLanceDbCache: boolean;
}

export async function removeLegacyEmbeddingsData(): Promise<LegacyEmbeddingsCleanup> {
  const indexFolder = getIndexFolderPath();
  const result: LegacyEmbeddingsCleanup = {
    removed: [],
    rowsRemoved: 0,
    droppedLanceDbCache: false,
  };

  for (const name of [
    "lancedb",
    "docs.sqlite",
    "docs.sqlite-wal",
    "docs.sqlite-shm",
    "docs.sqlite-journal",
  ]) {
    const target = path.join(indexFolder, name);
    try {
      await fs.access(target);
    } catch {
      continue;
    }
    await fs.rm(target, { recursive: true, force: true });
    result.removed.push(name);
  }

  const db = await SqliteDb.get();
  const table = await db.get(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lance_db_cache'",
  );
  if (table) {
    // The freed pages stay in index.sqlite and are reused by later writes;
    // VACUUM would block the extension host while it rewrites the file
    await db.exec("DROP TABLE lance_db_cache");
    result.droppedLanceDbCache = true;
  }
  for (const tableName of ["tag_catalog", "global_cache"]) {
    const { changes } = await db.run(
      `DELETE FROM ${tableName} WHERE artifactId LIKE ?`,
      `${LEGACY_ARTIFACT_PREFIX}%`,
    );
    result.rowsRemoved += changes;
  }

  return result;
}
