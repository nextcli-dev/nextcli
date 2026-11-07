/**
 * The node:sqlite wrapper must behave like the `sqlite` + `sqlite3` pair it
 * replaces: same call shapes, same stored value types, same files.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DevDataSqliteDb } from "../data/devdataSqlite";
import { getDevDataSqlitePath } from "./paths";
import { SqliteDatabase, sqliteHasFts5 } from "./sqlite";

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

describe("SqliteDatabase", () => {
  it("accepts varargs, an array, or named parameters", async () => {
    await db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    await db.run("INSERT INTO t VALUES (?, ?)", "x", 1);
    await db.run("INSERT INTO t VALUES (?, ?)", ["y", 2]);
    await db.run("INSERT INTO t VALUES (:a, :b)", { ":a": "z", ":b": 3 });

    expect(await db.all("SELECT * FROM t ORDER BY b")).toEqual([
      { a: "x", b: 1 },
      { a: "y", b: 2 },
      { a: "z", b: 3 },
    ]);
    expect(await db.get("SELECT a FROM t WHERE b = ?", 2)).toEqual({
      a: "y",
    });
    expect(await db.get("SELECT a FROM t WHERE b = ?", 99)).toBeUndefined();
  });

  it("stores values with the types sqlite3 used", async () => {
    // Columns without a declared type keep whatever type is bound
    await db.exec("CREATE TABLE t (v)");
    const values = [5, 1.5, true, false, undefined, null, "s", new Date(7)];
    for (const v of values) {
      await db.run("INSERT INTO t VALUES (?)", v);
    }

    expect(
      await db.all("SELECT typeof(v) AS type, v FROM t ORDER BY rowid"),
    ).toEqual([
      { type: "integer", v: 5 },
      { type: "real", v: 1.5 },
      { type: "integer", v: 1 },
      { type: "integer", v: 0 },
      { type: "null", v: null },
      { type: "null", v: null },
      { type: "text", v: "s" },
      { type: "integer", v: 7 },
    ]);
  });

  it("leaves foreign keys unenforced, like sqlite3", async () => {
    // The shape core's full-text index uses: fts_metadata references an
    // FTS5 table's rowid
    await db.exec("CREATE VIRTUAL TABLE fts USING fts5(content)");
    await db.exec(
      "CREATE TABLE fts_metadata (id INTEGER PRIMARY KEY, FOREIGN KEY (id) REFERENCES fts(rowid))",
    );
    const { lastID } = await db.run(
      "INSERT INTO fts (content) VALUES (?)",
      "x",
    );
    await db.run("INSERT INTO fts_metadata (id) VALUES (?)", lastID);
    expect(await db.get("PRAGMA foreign_keys")).toEqual({ foreign_keys: 0 });
  });

  it("gives the event loop a turn during a long run of calls", async () => {
    await db.exec("CREATE TABLE t (v INTEGER)");
    let timerFired = false;
    setTimeout(() => (timerFired = true), 0);

    const start = performance.now();
    let calls = 0;
    // Statements finish synchronously; without yielding, the timer couldn't
    // fire until this loop ends
    while (performance.now() - start < 200) {
      await db.run("INSERT INTO t VALUES (?)", calls++);
      if (timerFired) {
        break;
      }
    }

    expect(timerFired).toBe(true);
    expect(performance.now() - start).toBeLessThan(200);
  });

  it("detects FTS5 in this runtime", () => {
    // Node 22.16+ (what the tests run on) has it; VS Code 1.101-1.102 don't
    expect(sqliteHasFts5()).toBe(true);
  });

  it("returns lastID and changes from run", async () => {
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    expect(await db.run("INSERT INTO t (v) VALUES (?)", "a")).toEqual({
      lastID: 1,
      changes: 1,
    });
    await db.run("INSERT INTO t (v) VALUES (?)", "b");
    expect(await db.run("UPDATE t SET v = ?", "c")).toEqual({
      lastID: 2,
      changes: 2,
    });
  });

  it("binds prepared statement parameters at prepare time or at call time", async () => {
    await db.exec("CREATE TABLE t (a TEXT, b INTEGER)");
    await db.run("INSERT INTO t VALUES ('x', 1), ('y', 2)");

    const bound = await db.prepare("SELECT a FROM t WHERE b = ?", 1);
    expect(await bound.all()).toEqual([{ a: "x" }]);

    const unbound = await db.prepare("SELECT a FROM t WHERE b = ?");
    expect(await unbound.all(2)).toEqual([{ a: "y" }]);
  });

  it("commits a transaction, and rolls it back when the function throws", async () => {
    await db.exec("CREATE TABLE t (v INTEGER)");

    await db.transaction((tx) => {
      tx.run("INSERT INTO t VALUES (?)", 1);
      tx.run("INSERT INTO t VALUES (?)", 2);
    });
    await expect(
      db.transaction((tx) => {
        tx.run("INSERT INTO t VALUES (?)", 3);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await db.all("SELECT v FROM t")).toEqual([{ v: 1 }, { v: 2 }]);
    // The database is usable after a rollback
    await db.run("INSERT INTO t VALUES (?)", 4);
  });
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

  it("reads and writes a database file created by sqlite3", async () => {
    const require = createRequire(__filename);
    let sqlite3: any;
    try {
      sqlite3 = require("sqlite3");
    } catch {
      // sqlite3 is removed with dbinfoz; the file format doesn't change
      return;
    }
    const file = path.join(dir, "legacy.sqlite");
    await new Promise<void>((resolve, reject) => {
      const legacy = new sqlite3.Database(file);
      legacy.serialize(() => {
        legacy.run("PRAGMA journal_mode=WAL");
        legacy.run("CREATE TABLE t (n INTEGER, v)");
        legacy.run("INSERT INTO t VALUES (?, ?)", [1, 42]);
        legacy.close((err: Error | null) => (err ? reject(err) : resolve()));
      });
    });

    const reopened = await SqliteDatabase.open(file);
    await reopened.run("INSERT INTO t VALUES (?, ?)", 2, 43);
    expect(
      await reopened.all("SELECT n, typeof(v) AS type, v FROM t ORDER BY n"),
    ).toEqual([
      { n: 1, type: "integer", v: 42 },
      { n: 2, type: "integer", v: 43 },
    ]);
    await reopened.close();
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
