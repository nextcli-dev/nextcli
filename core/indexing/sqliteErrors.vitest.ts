/**
 * Index failures on node:sqlite: a corrupt index must fail indexing and offer
 * a rebuild (shouldClearIndexes), a busy database must not, and chunk inserts
 * must leave the event loop room to run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../llm/countTokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/countTokens")>()),
  countTokensAsync: async (text: string) => Math.ceil(text.length / 4),
}));

import CodebaseContextProvider from "../context/providers/CodebaseContextProvider";
import FileSystemIde from "../util/filesystem";
import { getIndexSqlitePath } from "../util/paths";
import { localPathToUri } from "../util/pathToUri";
import { SqliteDatabase, SqliteError } from "../util/sqlite";
import { ChunkCodebaseIndex } from "./chunk/ChunkCodebaseIndex";
import { CodebaseIndexer } from "./CodebaseIndexer";
import { SqliteDb } from "./refreshIndex";

let workspace: string;

async function indexerFor(ide: FileSystemIde) {
  const config = {
    contextProviders: [new CodebaseContextProvider({})],
    selectedModelByRole: {},
  };
  const configHandler: any = {
    loadConfig: async () => ({
      config,
      errors: [],
      configLoadInterrupted: false,
    }),
    onConfigUpdate: () => {},
  };
  ide.getWorkspaceDirs = async () => [];
  const indexer = new CodebaseIndexer(configHandler, ide, undefined, false);
  await indexer.initPromise;
  // Let the indexer's own start-up run (no workspace dirs) finish
  await new Promise((resolve) => setTimeout(resolve, 100));
  return indexer;
}

function corruptIndexFile() {
  fs.writeFileSync(
    getIndexSqlitePath(),
    "plain text, not a SQLite file ".repeat(10),
  );
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "nextcli-index-"));
  fs.writeFileSync(path.join(workspace, "a.ts"), "export const a = 1;\n");
});

afterEach(async () => {
  await SqliteDb.db?.close();
  SqliteDb.db = null;
  fs.rmSync(getIndexSqlitePath(), { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("indexing errors on node:sqlite", () => {
  it("fails and offers a rebuild when index.sqlite is corrupt", async () => {
    const indexer = await indexerFor(new FileSystemIde(workspace));
    await SqliteDb.db?.close();
    SqliteDb.db = null;
    corruptIndexFile();

    const updates = [];
    for await (const update of indexer.refreshDirs(
      [localPathToUri(workspace)],
      new AbortController().signal,
    )) {
      updates.push(update);
    }

    const last = updates[updates.length - 1];
    expect(last).toMatchObject({ status: "failed", shouldClearIndexes: true });
    expect(last.desc).toContain("file is not a database");
  });

  it("reports a failed lock on a corrupt index as a failure that offers a rebuild", async () => {
    const indexer = await indexerFor(new FileSystemIde(workspace));
    await SqliteDb.db?.close();
    SqliteDb.db = null;
    corruptIndexFile();

    await indexer.refreshCodebaseIndex([localPathToUri(workspace)]);

    expect(indexer.currentIndexingState).toMatchObject({
      status: "failed",
      shouldClearIndexes: true,
    });
  });

  it("fails the batch on corruption, but not on a busy database", async () => {
    const indexer = (await indexerFor(new FileSystemIde(workspace))) as any;
    const corrupt = new SqliteError({
      message: "database disk image is malformed",
      errcode: 11,
    });
    const busy = new SqliteError({
      message: "database is locked",
      errcode: 5,
    });
    // How ChunkCodebaseIndex wraps a failed insert
    const wrapped = new Error(
      `error inserting into chunks tables: ${corrupt.message}`,
      { cause: corrupt },
    );

    expect(indexer.shouldFailBatch(corrupt)).toBe(true);
    expect(indexer.shouldFailBatch(wrapped)).toBe(true);
    expect(indexer.shouldFailBatch(busy)).toBe(false);
    expect(indexer.errorToProgressUpdate(wrapped)).toMatchObject({
      status: "failed",
      shouldClearIndexes: true,
    });
  });
});

describe("chunk inserts", () => {
  it("run in short transactions that let the event loop run, and mark every file once", async () => {
    const db = await SqliteDatabase.open(path.join(workspace, "chunks.sqlite"));
    const index = new ChunkCodebaseIndex(
      async () => "",
      { connected: false } as any,
      500,
    ) as any;
    await index.createTables(db);

    const items = Array.from({ length: 60 }, (_, i) => ({
      path: `file:///f${i}.ts`,
      cacheKey: `key${i}`,
    }));
    const chunkLists = items.map((item) =>
      Array.from({ length: 400 }, (_, idx) => ({
        digest: item.cacheKey,
        filepath: item.path,
        index: idx,
        startLine: idx,
        endLine: idx,
        content: `chunk ${idx} of ${item.path} `.repeat(20),
      })),
    );
    const marked: string[][] = [];
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);

    await index.insertChunksInSlices(
      db,
      "tag",
      items,
      chunkLists,
      async (completed: typeof items) => {
        marked.push(completed.map((item) => item.path));
      },
    );
    clearInterval(timer);

    expect(ticks).toBeGreaterThan(0);
    expect(marked.length).toBeGreaterThan(1);
    expect(marked.flat()).toEqual(items.map((item) => item.path));
    expect(await db.get("SELECT count(*) AS n FROM chunks")).toEqual({
      n: 60 * 400,
    });
    await db.close();
  });
});
