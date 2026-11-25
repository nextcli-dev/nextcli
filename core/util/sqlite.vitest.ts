/**
 * Databases core writes through the node:sqlite wrapper open as sqlite3 left
 * them. The wrapper's own tests are in packages/context/test/sqlite.test.ts.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DevDataSqliteDb } from "../data/devdataSqlite";
import { getDevDataSqlitePath } from "./paths";
import { SqliteDatabase } from "./sqlite";

let dir: string;
let db: SqliteDatabase;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextcli-sqlite-"));
  db = await SqliteDatabase.open(path.join(dir, "test.sqlite"));
});

afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("existing databases", () => {
  it("upgrades a dev data database written before tokens_prompt existed", async () => {
    const file = getDevDataSqlitePath();
    fs.rmSync(file, { force: true });
    const old = await SqliteDatabase.open(file);
    await old.exec(`CREATE TABLE tokens_generated (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      tokens_generated INTEGER NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await old.run(
      "INSERT INTO tokens_generated (model, provider, tokens_generated) VALUES (?, ?, ?)",
      "old-model",
      "openai",
      40,
    );
    await old.close();

    DevDataSqliteDb.db = null;
    await DevDataSqliteDb.logTokensGenerated("new-model", "anthropic", 7, 3);

    const perModel = await DevDataSqliteDb.getTokensPerModel();
    expect(perModel).toEqual(
      expect.arrayContaining([
        { model: "old-model", promptTokens: 0, generatedTokens: 40 },
        { model: "new-model", promptTokens: 7, generatedTokens: 3 },
      ]),
    );
    await DevDataSqliteDb.db!.close();
    DevDataSqliteDb.db = null;
  });

  it("lets two processes write one WAL database at the same time", async () => {
    const file = path.join(dir, "shared.sqlite");
    await db.close();
    db = await SqliteDatabase.open(file);
    await db.exec("PRAGMA journal_mode=WAL");
    await db.exec("CREATE TABLE t (writer INTEGER, n INTEGER)");

    // The app's settings for index.sqlite: WAL and a 3 s busy timeout
    const writer = (id: number) =>
      new Promise<number>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            "-e",
            `const { DatabaseSync } = require("node:sqlite");
             const db = new DatabaseSync(${JSON.stringify(file)});
             db.exec("PRAGMA busy_timeout = 3000");
             const insert = db.prepare("INSERT INTO t VALUES (?, ?)");
             for (let i = 0; i < 500; i++) {
               db.exec("BEGIN IMMEDIATE");
               insert.run(${id}, i);
               db.exec("COMMIT");
             }
             db.close();`,
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve(code) : reject(new Error(stderr)),
        );
      });

    await Promise.all([writer(1), writer(2)]);

    expect(
      await db.all(
        "SELECT writer, count(*) AS rows FROM t GROUP BY writer ORDER BY writer",
      ),
    ).toEqual([
      { writer: 1, rows: 500 },
      { writer: 2, rows: 500 },
    ]);
    expect(await db.get("PRAGMA integrity_check")).toEqual({
      integrity_check: "ok",
    });
  }, 30000);
});
