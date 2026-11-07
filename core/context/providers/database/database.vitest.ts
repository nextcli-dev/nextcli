/**
 * The @database adapters must return what dbinfoz 0.14.0 returned, so the
 * context items don't change. Expected output comes from
 * core/test/fixtures/regression/database/golden.json, recorded with dbinfoz.
 *
 * - SQLite always runs: the database is rebuilt from the recorded schema SQL.
 * - Postgres, MySQL and MSSQL run with NEXTCLI_DB_TESTS=1, against the
 *   servers in scripts/regression/database/compose.yaml (or CI services).
 * - With DBINFOZ_DIR pointing at an install of dbinfoz@0.14.0, each server
 *   engine is also compared with dbinfoz's live output. That covers MSSQL,
 *   which has no recording (its image doesn't run on Apple Silicon).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SqliteDatabase } from "../../../util/sqlite";
import DatabaseContextProvider from "../DatabaseContextProvider";
import { DatabaseType, getAllTablesAndSchemas } from "./index";

const golden = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      "../../../test/fixtures/regression/database/golden.json",
    ),
    "utf8",
  ),
);

// Passwords from scripts/regression/database/compose.yaml (redacted in the
// golden file)
const PASSWORDS: Record<string, string> = {
  postgres: "fixture-password",
  mysql: "fixture-password",
  mssql: "Fixture-Passw0rd!",
};

function connectionFor(engine: string) {
  return { ...golden.engines[engine].connection, password: PASSWORDS[engine] };
}

const SERVER_TESTS = process.env.NEXTCLI_DB_TESTS === "1";
const DBINFOZ_DIR = process.env.DBINFOZ_DIR;

/** Retries until the server accepts connections (MSSQL takes a while) */
async function untilReady(fn: () => Promise<void>, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (Date.now() > deadline) {
        throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

async function seed(engine: string) {
  const schema: string[] = golden.engines[engine].schema;
  const connection = connectionFor(engine);
  if (engine === "postgres") {
    const { Client } = (await import("pg")).default;
    const client = new Client(connection);
    await client.connect();
    try {
      for (const sql of schema) await client.query(sql);
    } finally {
      await client.end();
    }
  } else if (engine === "mysql") {
    const mysql = (await import("mysql2/promise")).default;
    const client = await mysql.createConnection(connection);
    try {
      for (const sql of schema) await client.query(sql);
    } finally {
      await client.end();
    }
  } else if (engine === "mssql") {
    const mssql: any = (await import("mssql")).default;
    // The database doesn't exist yet: connect to the server's default one
    const { database: _database, ...server } = connection;
    const pool = await new mssql.ConnectionPool(server).connect();
    try {
      for (const sql of schema) await pool.request().query(sql);
    } finally {
      await pool.close();
    }
  }
}

async function dbinfozOutput(engine: string, connection: object) {
  const entry = path.join(DBINFOZ_DIR!, "node_modules/dbinfoz/src/index.js");
  const { getDatabaseAdapter } = await import(pathToFileURL(entry).href);
  const adapter = getDatabaseAdapter(engine, { ...connection });
  if (engine === "mssql") {
    await adapter.isConnected();
  }
  try {
    return await adapter.getAllTablesAndSchemas();
  } finally {
    await adapter.pool?.end?.();
    await adapter.pool?.close?.();
  }
}

/** Context items the provider builds for a connection named "shop" */
async function contextItems(type: DatabaseType, connection: object) {
  const provider = new DatabaseContextProvider({
    connections: [
      { name: "shop", connection_type: type, connection: { ...connection } },
    ],
  });
  const all = await provider.getContextItems("shop.all", {} as any);
  const users = await provider.getContextItems("shop.users", {} as any);
  const submenu = await provider.loadSubmenuItems({} as any);
  return { all, users, submenu };
}

describe("@database on SQLite", () => {
  let dir: string;
  let filename: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nextcli-db-"));
    filename = path.join(dir, "shop.sqlite");
    const db = await SqliteDatabase.open(filename);
    for (const sql of golden.engines.sqlite.schema) {
      await db.exec(sql);
    }
    await db.close();
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("returns the recorded tables and schemas", async () => {
    const result = await getAllTablesAndSchemas("sqlite", { filename });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify(golden.engines.sqlite.tablesAndSchemas),
    );
  });

  it("builds the same context items", async () => {
    const { all, users, submenu } = await contextItems("sqlite", {
      filename,
      database: "shop",
    });
    expect(all).toEqual([
      {
        name: "shop-all-tables-schemas",
        description: "Schema for all tables.",
        content: golden.engines.sqlite.allTablesPrompt,
      },
    ]);
    expect(users).toEqual([
      {
        name: "shop-users-schema",
        description: "users Schema",
        content: `Schema for users on sqlite is ${JSON.stringify(
          golden.engines.sqlite.tablesAndSchemas.users,
        )}`,
      },
    ]);
    expect(submenu.map((item) => item.id)).toEqual([
      "shop.all",
      "shop.users",
      "shop.orders",
    ]);
  });
});

describe.runIf(SERVER_TESTS).each(["postgres", "mysql", "mssql"] as const)(
  "@database on %s",
  (engine) => {
    beforeAll(() => untilReady(() => seed(engine)), 150000);

    it.runIf(!!golden.engines[engine].tablesAndSchemas)(
      "returns the recorded tables and schemas",
      async () => {
        const result = await getAllTablesAndSchemas(
          engine,
          connectionFor(engine),
        );
        expect(JSON.stringify(result)).toBe(
          JSON.stringify(golden.engines[engine].tablesAndSchemas),
        );
      },
    );

    it.runIf(!!DBINFOZ_DIR)(
      "returns what dbinfoz returns on the same server",
      async () => {
        const connection = connectionFor(engine);
        const expected = await dbinfozOutput(engine, connection);
        const result = await getAllTablesAndSchemas(engine, connection);
        expect(Object.keys(result).sort()).toEqual(["orders", "users"]);
        expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
      },
      60000,
    );
  },
);
