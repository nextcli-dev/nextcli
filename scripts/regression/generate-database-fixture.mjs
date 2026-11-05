#!/usr/bin/env node
// Records what the @database context provider gets from dbinfoz 0.14.0:
// the result of getAllTablesAndSchemas() for the same two-table schema on
// SQLite, Postgres, MySQL and MSSQL. Phase 6 of the dependency upgrade checks
// its replacement against this output.
//
//   podman-compose -f scripts/regression/database/compose.yaml up -d
//   node scripts/regression/generate-database-fixture.mjs
//   podman-compose -f scripts/regression/database/compose.yaml down
//
// Writes core/test/fixtures/regression/database/golden.json: per engine, the
// connection config used, the schema SQL that seeded it, and the output (or
// the error if that engine was unreachable). The SQLite database is built in a
// temporary folder and not committed; Phase 6's test rebuilds it from the
// recorded schema SQL.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CORE = path.join(ROOT, "core");
const requireFromCore = createRequire(path.join(CORE, "package.json"));
const OUT = path.join(ROOT, "core/test/fixtures/regression/database");
const READY_TIMEOUT_MS = 180_000;

// The same logical schema in each dialect.
export const SCHEMA = {
  sqlite: [
    `CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), total NUMERIC(10,2) NOT NULL, status TEXT DEFAULT 'new')`,
  ],
  postgres: [
    `DROP TABLE IF EXISTS orders`,
    `DROP TABLE IF EXISTS users`,
    `CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT now())`,
    `CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), total NUMERIC(10,2) NOT NULL, status TEXT DEFAULT 'new')`,
  ],
  mysql: [
    `DROP TABLE IF EXISTS orders`,
    `DROP TABLE IF EXISTS users`,
    `CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE orders (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, total DECIMAL(10,2) NOT NULL, status TEXT, FOREIGN KEY (user_id) REFERENCES users(id))`,
  ],
  mssql: [
    `IF DB_ID('shop') IS NULL CREATE DATABASE shop`,
    `USE shop`,
    `IF OBJECT_ID('orders') IS NOT NULL DROP TABLE orders`,
    `IF OBJECT_ID('users') IS NOT NULL DROP TABLE users`,
    `CREATE TABLE users (id INT IDENTITY PRIMARY KEY, email NVARCHAR(255) NOT NULL UNIQUE, created_at DATETIME2 DEFAULT SYSDATETIME())`,
    `CREATE TABLE orders (id INT IDENTITY PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), total DECIMAL(10,2) NOT NULL, status NVARCHAR(50) DEFAULT 'new')`,
  ],
};

// Connection configs in the shape users put under `connection` in their
// config, which DatabaseContextProvider passes to dbinfoz unchanged.
const CONNECTIONS = {
  // Set in main(): a temporary file, so importing this module has no side effects.
  sqlite: { filename: null, database: "shop" },
  postgres: {
    host: "127.0.0.1",
    port: 15432,
    user: "fixture",
    password: "fixture-password",
    database: "shop",
  },
  mysql: {
    host: "127.0.0.1",
    port: 13306,
    user: "fixture",
    password: "fixture-password",
    database: "shop",
  },
  mssql: {
    server: "127.0.0.1",
    port: 11433,
    user: "sa",
    password: "Fixture-Passw0rd!",
    database: "shop",
    options: { trustServerCertificate: true },
  },
};

async function seedSqlite(file) {
  const sqlite3 = requireFromCore("sqlite3");
  const db = new sqlite3.Database(file);
  for (const sql of SCHEMA.sqlite) {
    await new Promise((res, rej) => db.run(sql, (e) => (e ? rej(e) : res())));
  }
  await new Promise((res) => db.close(res));
}

/** Retries a connect-and-seed function until the server accepts it. */
async function untilReady(name, fn) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(
    `${name} not ready after ${READY_TIMEOUT_MS / 1000}s: ${lastErr?.message}`,
  );
}

const SEEDERS = {
  postgres: () =>
    untilReady("postgres", async () => {
      const { Client } = requireFromCore("pg");
      const c = new Client(CONNECTIONS.postgres);
      await c.connect();
      try {
        for (const sql of SCHEMA.postgres) await c.query(sql);
      } finally {
        await c.end();
      }
    }),
  mysql: () =>
    untilReady("mysql", async () => {
      const mysql = requireFromCore("mysql2/promise");
      const c = await mysql.createConnection(CONNECTIONS.mysql);
      try {
        for (const sql of SCHEMA.mysql) await c.query(sql);
      } finally {
        await c.end();
      }
    }),
  mssql: () =>
    untilReady("mssql", async () => {
      const mssql = requireFromCore("mssql");
      const pool = await new mssql.ConnectionPool({
        ...CONNECTIONS.mssql,
        database: "master",
      }).connect();
      try {
        for (const sql of SCHEMA.mssql) await pool.request().batch(sql);
      } finally {
        await pool.close();
      }
    }),
};

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  CONNECTIONS.sqlite.filename = path.join(
    mkdtempSync(path.join(os.tmpdir(), "nextcli-db-fixture-")),
    "shop.sqlite",
  );
  await seedSqlite(CONNECTIONS.sqlite.filename);

  const dbinfozEntry = requireFromCore.resolve("dbinfoz");
  const { getDatabaseAdapter } = await import(pathToFileURL(dbinfozEntry).href);

  const golden = {
    generatedWith: {
      dbinfoz: requireFromCore("dbinfoz/package.json").version,
      node: process.version,
    },
    engines: {},
  };
  for (const engine of ["sqlite", "postgres", "mysql", "mssql"]) {
    const connection = CONNECTIONS[engine];
    // Recorded with the absolute path stripped so the file is portable.
    const recordedConnection =
      engine === "sqlite"
        ? { ...connection, filename: "<temp>/shop.sqlite" }
        : { ...connection, password: "<redacted>" };
    try {
      if (SEEDERS[engine]) await SEEDERS[engine]();
      const adapter = getDatabaseAdapter(engine, connection);
      const tablesAndSchemas = await adapter.getAllTablesAndSchemas(
        connection.database,
      );
      golden.engines[engine] = {
        connection: recordedConnection,
        schema: SCHEMA[engine],
        tablesAndSchemas,
        // What the provider puts in the prompt for `<name>.all`.
        allTablesPrompt: `Schema for all tables on ${engine} is ${JSON.stringify(tablesAndSchemas)}`,
      };
      await adapter.pool?.end?.();
      await adapter.pool?.close?.();
      adapter.db?.close?.();
      console.log(`${engine}: ${Object.keys(tablesAndSchemas).join(", ")}`);
    } catch (err) {
      golden.engines[engine] = {
        connection: recordedConnection,
        schema: SCHEMA[engine],
        error: String(err?.message ?? err),
      };
      console.log(`${engine}: not recorded (${err?.message ?? err})`);
    }
  }
  writeFileSync(
    path.join(OUT, "golden.json"),
    JSON.stringify(golden, null, 2) + "\n",
  );
  console.log(`Wrote ${path.relative(ROOT, OUT)}/golden.json`);
  rmSync(path.dirname(CONNECTIONS.sqlite.filename), { recursive: true });
  process.exit(0); // driver pools can keep the event loop alive
}

// Run only when called directly, so Phase 6's test can import SCHEMA.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
