import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getIndexFolderPath } from "../util/paths";
import { SqliteDb } from "./refreshIndex";
import { removeLegacyEmbeddingsData } from "./removeLegacyEmbeddingsData";

const indexFolder = () => getIndexFolderPath();

async function writeLegacyLayout() {
  // LanceDB tables, as releases with embeddings left them
  const lance = path.join(indexFolder(), "lancedb", "codebase_main.lance");
  fs.mkdirSync(path.join(lance, "data"), { recursive: true });
  fs.writeFileSync(path.join(lance, "data", "0.lance"), "vectors");
  fs.writeFileSync(path.join(indexFolder(), "docs.sqlite"), "docs metadata");
  fs.writeFileSync(path.join(indexFolder(), "docs.sqlite-wal"), "wal");

  const db = await SqliteDb.get();
  await db.exec(`CREATE TABLE IF NOT EXISTS lance_db_cache (
    uuid TEXT PRIMARY KEY, cacheKey TEXT NOT NULL, path TEXT NOT NULL,
    artifact_id TEXT NOT NULL, vector TEXT NOT NULL, startLine INTEGER NOT NULL,
    endLine INTEGER NOT NULL, contents TEXT NOT NULL
  )`);
  await db.run(
    "INSERT INTO lance_db_cache VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    "u1",
    "key1",
    "/repo/a.ts",
    "vectordb::all-MiniLM-L6-v2",
    "[0.1,0.2]",
    0,
    1,
    "const a = 1;",
  );
  for (const artifactId of [
    "vectordb::all-MiniLM-L6-v2",
    "vectordb::openai::text-embedding-3-small",
    "chunks",
    "sqliteFts",
  ]) {
    await db.run(
      "INSERT INTO tag_catalog (dir, branch, artifactId, path, cacheKey, lastUpdated) VALUES (?, ?, ?, ?, ?, ?)",
      "/repo",
      "main",
      artifactId,
      "/repo/a.ts",
      "key1",
      1,
    );
    await db.run(
      "INSERT INTO global_cache (cacheKey, dir, branch, artifactId) VALUES (?, ?, ?, ?)",
      "key1",
      "/repo",
      "main",
      artifactId,
    );
  }
}

beforeEach(async () => {
  fs.mkdirSync(indexFolder(), { recursive: true });
  await SqliteDb.db?.close();
  SqliteDb.db = null;
  fs.rmSync(path.join(indexFolder(), "index.sqlite"), { force: true });
});

afterEach(async () => {
  await SqliteDb.db?.close();
  SqliteDb.db = null;
});

describe("removeLegacyEmbeddingsData", () => {
  it("removes LanceDB, docs.sqlite and the embeddings rows, and keeps the rest", async () => {
    await writeLegacyLayout();

    const result = await removeLegacyEmbeddingsData();

    expect(result).toEqual({
      removed: ["lancedb", "docs.sqlite", "docs.sqlite-wal"],
      rowsRemoved: 4,
      droppedLanceDbCache: true,
    });
    expect(fs.existsSync(path.join(indexFolder(), "lancedb"))).toBe(false);
    expect(fs.existsSync(path.join(indexFolder(), "docs.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(indexFolder(), "index.sqlite"))).toBe(true);

    const db = await SqliteDb.get();
    expect(
      await db.get(
        "SELECT name FROM sqlite_master WHERE name = 'lance_db_cache'",
      ),
    ).toBeUndefined();
    for (const table of ["tag_catalog", "global_cache"]) {
      expect(
        await db.all(`SELECT artifactId FROM ${table} ORDER BY artifactId`),
      ).toEqual([{ artifactId: "chunks" }, { artifactId: "sqliteFts" }]);
    }
  });

  it("does nothing when there is nothing left to remove", async () => {
    await writeLegacyLayout();
    await removeLegacyEmbeddingsData();

    expect(await removeLegacyEmbeddingsData()).toEqual({
      removed: [],
      rowsRemoved: 0,
      droppedLanceDbCache: false,
    });
  });
});
