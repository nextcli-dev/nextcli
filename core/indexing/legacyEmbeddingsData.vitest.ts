import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalContext } from "../util/GlobalContext";
import { getIndexFolderPath, getIndexSqlitePath } from "../util/paths";
import {
  findLegacyEmbeddingsData,
  formatBytes,
  LEGACY_CLEANUP_DELETE,
  LEGACY_CLEANUP_KEEP,
  LEGACY_CLEANUP_NEVER,
  offerLegacyEmbeddingsCleanup,
  removeLegacyEmbeddingsData,
} from "./legacyEmbeddingsData";
import { SqliteDb } from "./refreshIndex";

const indexFolder = () => getIndexFolderPath();

async function writeLegacyLayout() {
  // LanceDB tables and @docs data, as releases with embeddings left them
  const lance = path.join(indexFolder(), "lancedb", "codebase_main.lance");
  fs.mkdirSync(path.join(lance, "data"), { recursive: true });
  fs.writeFileSync(path.join(lance, "data", "0.lance"), "x".repeat(1000));
  fs.writeFileSync(path.join(indexFolder(), "docs.sqlite"), "y".repeat(200));
  fs.writeFileSync(path.join(indexFolder(), "docs.sqlite-wal"), "z".repeat(50));

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

async function resetIndex() {
  await SqliteDb.db?.close();
  SqliteDb.db = null;
  fs.rmSync(getIndexSqlitePath(), { force: true });
  for (const name of ["lancedb", "docs.sqlite", "docs.sqlite-wal"]) {
    fs.rmSync(path.join(indexFolder(), name), { recursive: true, force: true });
  }
}

function fakeIde(choice?: string) {
  return { showToast: vi.fn(async () => choice) } as any;
}

beforeEach(async () => {
  fs.mkdirSync(indexFolder(), { recursive: true });
  await resetIndex();
  new GlobalContext().update("hasDismissedLegacyEmbeddingsCleanup", false);
});

afterEach(resetIndex);

describe("findLegacyEmbeddingsData", () => {
  it("measures the legacy data without changing anything", async () => {
    await writeLegacyLayout();

    const found = await findLegacyEmbeddingsData();

    expect(found).toEqual({
      files: [
        { name: "lancedb", bytes: 1000 },
        { name: "docs.sqlite", bytes: 200 },
        { name: "docs.sqlite-wal", bytes: 50 },
      ],
      // lance_db_cache, plus one vectordb:: row in each of the two tables
      indexRows: 3,
      indexBytes: "[0.1,0.2]".length + "const a = 1;".length + 10,
      totalBytes: 1250 + 31,
    });
    expect(fs.existsSync(path.join(indexFolder(), "lancedb"))).toBe(true);
  });

  it("finds nothing, and doesn't create index.sqlite, when there is no index", async () => {
    expect(await findLegacyEmbeddingsData()).toBeUndefined();
    expect(fs.existsSync(getIndexSqlitePath())).toBe(false);
  });
});

describe("removeLegacyEmbeddingsData", () => {
  it("removes LanceDB, docs.sqlite and the embeddings rows, and keeps the rest", async () => {
    await writeLegacyLayout();

    expect(await removeLegacyEmbeddingsData()).toMatchObject({ indexRows: 3 });

    expect(fs.existsSync(path.join(indexFolder(), "lancedb"))).toBe(false);
    expect(fs.existsSync(path.join(indexFolder(), "docs.sqlite"))).toBe(false);
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
    expect(await removeLegacyEmbeddingsData()).toBeUndefined();
  });
});

describe("offerLegacyEmbeddingsCleanup", () => {
  it("deletes the data when the user chooses Delete", async () => {
    await writeLegacyLayout();
    const ide = fakeIde(LEGACY_CLEANUP_DELETE);

    await offerLegacyEmbeddingsCleanup(ide, { fromCommand: false });

    expect(ide.showToast.mock.calls[0]).toEqual([
      "info",
      expect.stringContaining(formatBytes(1281)),
      LEGACY_CLEANUP_DELETE,
      LEGACY_CLEANUP_KEEP,
      LEGACY_CLEANUP_NEVER,
    ]);
    expect(await findLegacyEmbeddingsData()).toBeUndefined();
    expect(ide.showToast.mock.calls[1][1]).toContain("Deleted");
  });

  it("keeps the data, and asks again next time, when the user chooses Keep", async () => {
    await writeLegacyLayout();
    await offerLegacyEmbeddingsCleanup(fakeIde(LEGACY_CLEANUP_KEEP), {
      fromCommand: false,
    });
    expect(await findLegacyEmbeddingsData()).toBeDefined();

    const next = fakeIde(LEGACY_CLEANUP_KEEP);
    await offerLegacyEmbeddingsCleanup(next, { fromCommand: false });
    expect(next.showToast).toHaveBeenCalledTimes(1);
  });

  it("stops asking on start-up after Don't show again, but the command still asks", async () => {
    await writeLegacyLayout();
    await offerLegacyEmbeddingsCleanup(fakeIde(LEGACY_CLEANUP_NEVER), {
      fromCommand: false,
    });

    const startUp = fakeIde();
    await offerLegacyEmbeddingsCleanup(startUp, { fromCommand: false });
    expect(startUp.showToast).not.toHaveBeenCalled();

    const command = fakeIde(LEGACY_CLEANUP_KEEP);
    await offerLegacyEmbeddingsCleanup(command, { fromCommand: true });
    expect(command.showToast.mock.calls[0].slice(2)).toEqual([
      LEGACY_CLEANUP_DELETE,
      LEGACY_CLEANUP_KEEP,
    ]);
  });

  it("says so from the command when there is nothing to delete, and stays quiet on start-up", async () => {
    const startUp = fakeIde();
    await offerLegacyEmbeddingsCleanup(startUp, { fromCommand: false });
    expect(startUp.showToast).not.toHaveBeenCalled();

    const command = fakeIde();
    await offerLegacyEmbeddingsCleanup(command, { fromCommand: true });
    expect(command.showToast).toHaveBeenCalledWith(
      "info",
      "No legacy index data found.",
    );
  });
});
