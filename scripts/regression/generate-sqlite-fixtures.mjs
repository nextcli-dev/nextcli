#!/usr/bin/env node
// Writes SQLite files with today's native sqlite3 driver, the way nextcli
// creates them, plus a snapshot of their schemas and row counts. Phase 6 of
// the dependency upgrade opens these with the replacement driver and checks
// that reads, writes and the app's own schema upgrades still work.
//
// Run once, before sqlite3 is removed:
//   node scripts/regression/generate-sqlite-fixtures.mjs
//
// Writes core/test/fixtures/regression/sqlite/:
//   autocompleteCache.sqlite  `cache` table (AutocompleteLruCache.ts)
//   devdata.sqlite            `tokens_generated` in its current shape (devdataSqlite.ts)
//   devdata-legacy.sqlite     `tokens_generated` before the tokens_prompt column,
//                             so the app's ALTER TABLE upgrade runs against it
//   snapshot.json             schema SQL and row counts of these files and of the
//                             LanceDB fixture's index.sqlite

import crypto from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sqlite3 = createRequire(path.join(ROOT, "core/package.json"))("sqlite3");
const OUT = path.join(ROOT, "core/test/fixtures/regression/sqlite");
const LANCEDB_FIXTURE_SQLITE = path.join(
  ROOT,
  "core/test/fixtures/regression/lancedb-legacy/index/index.sqlite",
);
const FIXED_TIME_MS = 1762300800000; // 2025-11-05T00:00:00Z

const open = (file) =>
  new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) =>
      err ? reject(err) : resolve(db),
    );
  });
const run = (db, sql, params = []) =>
  new Promise((resolve, reject) =>
    db.run(sql, params, (err) => (err ? reject(err) : resolve())),
  );
const all = (db, sql) =>
  new Promise((resolve, reject) =>
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))),
  );
const close = (db) =>
  new Promise((resolve, reject) =>
    db.close((err) => (err ? reject(err) : resolve())),
  );
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function snapshot(file) {
  const db = await open(file);
  const tables = await all(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const result = {};
  for (const { name, sql } of tables) {
    const [{ n }] = await all(db, `SELECT COUNT(*) AS n FROM "${name}"`);
    result[name] = { rows: n, sql: sql.replace(/\s+/g, " ").trim() };
  }
  await close(db);
  return result;
}

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // AutocompleteLruCache.ts schema; keys are prefix hashes, values completions.
  {
    const db = await open(path.join(OUT, "autocompleteCache.sqlite"));
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          )`,
    );
    for (let i = 0; i < 50; i++) {
      await run(
        db,
        "INSERT INTO cache (key, value, timestamp) VALUES (?, ?, ?)",
        [
          hash(`prefix-${i}`),
          `completion number ${i}\n  with a second line — and non-ASCII: ü, 日本, 🙂`,
          FIXED_TIME_MS + i * 1000,
        ],
      );
    }
    await close(db);
  }

  // devdataSqlite.ts, current shape.
  const devdataRows = [
    ["gpt-4o", "openai", 1200, 340],
    ["claude-sonnet-5-5", "anthropic", 5400, 980],
    ["llama3.1:8b", "ollama", 300, 120],
  ];
  {
    const db = await open(path.join(OUT, "devdata.sqlite"));
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS tokens_generated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            tokens_generated INTEGER NOT NULL,
            tokens_prompt INTEGER NOT NULL DEFAULT 0,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
    );
    for (const [model, provider, prompt, generated] of devdataRows) {
      await run(
        db,
        "INSERT INTO tokens_generated (model, provider, tokens_prompt, tokens_generated, timestamp) VALUES (?, ?, ?, ?, ?)",
        [model, provider, prompt, generated, "2025-11-05 00:00:00"],
      );
    }
    await close(db);
  }

  // devdataSqlite.ts before tokens_prompt existed (older installs).
  {
    const db = await open(path.join(OUT, "devdata-legacy.sqlite"));
    await run(
      db,
      `CREATE TABLE IF NOT EXISTS tokens_generated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model TEXT NOT NULL,
            provider TEXT NOT NULL,
            tokens_generated INTEGER NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
    );
    for (const [model, provider, , generated] of devdataRows) {
      await run(
        db,
        "INSERT INTO tokens_generated (model, provider, tokens_generated, timestamp) VALUES (?, ?, ?, ?)",
        [model, provider, generated, "2025-11-05 00:00:00"],
      );
    }
    await close(db);
  }

  const files = {
    "sqlite/autocompleteCache.sqlite": path.join(
      OUT,
      "autocompleteCache.sqlite",
    ),
    "sqlite/devdata.sqlite": path.join(OUT, "devdata.sqlite"),
    "sqlite/devdata-legacy.sqlite": path.join(OUT, "devdata-legacy.sqlite"),
  };
  if (existsSync(LANCEDB_FIXTURE_SQLITE)) {
    files["lancedb-legacy/index/index.sqlite"] = LANCEDB_FIXTURE_SQLITE;
  } else {
    console.warn(
      "LanceDB fixture not found; run generate-lancedb-fixture.mjs first to include its index.sqlite",
    );
  }
  const result = {
    generatedWith: {
      sqlite3: createRequire(path.join(ROOT, "core/package.json"))(
        "sqlite3/package.json",
      ).version,
      node: process.version,
    },
    files: {},
  };
  for (const [name, file] of Object.entries(files)) {
    result.files[name] = await snapshot(file);
  }
  writeFileSync(
    path.join(OUT, "snapshot.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(
    `Wrote ${path.relative(ROOT, OUT)}: ` +
      Object.entries(result.files)
        .map(
          ([n, t]) =>
            `${n} (${Object.entries(t)
              .map(([k, v]) => `${k}=${v.rows}`)
              .join(", ")})`,
        )
        .join("; "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
