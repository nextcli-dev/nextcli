/**
 * A small async wrapper over Node's built-in `node:sqlite`, with the subset of
 * the `sqlite` package API that core uses. It replaces `sqlite` + `sqlite3`,
 * whose native binary pulled in the deprecated `prebuild-install`.
 *
 * The file format doesn't depend on the driver, so databases written by
 * `sqlite3` open unchanged. Parameters are converted so values are stored the
 * way `sqlite3` stored them:
 * - integers bind as INTEGER (`node:sqlite` binds every JS number as REAL,
 *   which changes the stored type in columns without a declared type);
 * - booleans bind as 1/0 and `undefined` as NULL (`node:sqlite` rejects both);
 * - Dates bind as milliseconds since the epoch.
 *
 * `node:sqlite` is synchronous: calls run on the calling thread. The methods
 * stay async so call sites keep their shape.
 */
// The parts of node:sqlite used here, typed locally: packages that typecheck
// core's sources (gui) have @types/node versions without node:sqlite
type SQLInputValue = null | number | bigint | string | Uint8Array;

interface StatementSync {
  all(...params: any[]): unknown[];
  get(...params: any[]): unknown;
  run(...params: any[]): {
    lastInsertRowid: number | bigint;
    changes: number | bigint;
  };
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

interface NodeSqlite {
  DatabaseSync: new (
    path: string,
    options?: {
      enableForeignKeyConstraints?: boolean;
      enableDoubleQuotedStringLiterals?: boolean;
    },
  ) => DatabaseSync;
}

// Loaded lazily through process.getBuiltinModule: it works the same in
// CommonJS, ESM and bundles, and code paths that never open a database don't
// load the module (or print its ExperimentalWarning on Node 22)
function loadNodeSqlite(): NodeSqlite {
  return (
    process as unknown as { getBuiltinModule(id: string): unknown }
  ).getBuiltinModule("node:sqlite") as NodeSqlite;
}

// node:sqlite runs each statement synchronously, so the promises below are
// already settled when returned. A loop that awaits them would never give the
// event loop a turn (no timers, I/O or IPC) until it ends. Yield to it once a
// run of calls has held the thread for this long
const YIELD_AFTER_MS = 20;
let busySince: number | undefined;

async function yieldIfBusy(): Promise<void> {
  const now = performance.now();
  if (busySince === undefined) {
    busySince = now;
    return;
  }
  if (now - busySince >= YIELD_AFTER_MS) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    busySince = undefined;
  }
}

let fts5Available: boolean | undefined;

/**
 * Whether this runtime's SQLite has FTS5, which the full-text index needs.
 * node:sqlite got FTS5 in Node 22.16; VS Code 1.101 and 1.102 ship Node
 * 22.15 without it, and forks may lag further behind.
 */
export function sqliteHasFts5(): boolean {
  if (fts5Available === undefined) {
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE fts5_probe USING fts5(content)");
      fts5Available = true;
    } catch {
      fts5Available = false;
    } finally {
      db.close();
    }
  }
  return fts5Available;
}

export type SqlParam =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | Uint8Array;

type Params = SqlParam[] | [SqlParam[]] | [Record<string, SqlParam>];

export interface RunResult {
  /** Row id of the last inserted row */
  lastID: number;
  /** Number of rows changed by the statement */
  changes: number;
}

function toSqlValue(value: SqlParam): SQLInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : value;
  }
  if (value instanceof Date) {
    return BigInt(value.getTime());
  }
  return value;
}

/** Accepts `(a, b)`, `([a, b])` or `({ ":name": a })`, like the `sqlite` package */
function normalizeParams(
  params: Params,
): SQLInputValue[] | [Record<string, SQLInputValue>] {
  if (params.length === 1) {
    const [only] = params;
    if (Array.isArray(only)) {
      return only.map(toSqlValue);
    }
    if (
      only !== null &&
      typeof only === "object" &&
      !(only instanceof Date) &&
      !(only instanceof Uint8Array)
    ) {
      const named: Record<string, SQLInputValue> = {};
      for (const [key, value] of Object.entries(only)) {
        named[key] = toSqlValue(value);
      }
      return [named];
    }
  }
  return (params as SqlParam[]).map(toSqlValue);
}

/** Rows come back with a null prototype; callers expect plain objects */
function toPlain<T>(row: unknown): T {
  return (row ? { ...(row as object) } : row) as T;
}

function toRunResult(result: {
  lastInsertRowid: number | bigint;
  changes: number | bigint;
}): RunResult {
  return {
    lastID: Number(result.lastInsertRowid),
    changes: Number(result.changes),
  };
}

export interface SqliteTransaction {
  run(sql: string, ...params: Params): RunResult;
}

export class SqliteStatement {
  private readonly bound: SQLInputValue[] | [Record<string, SQLInputValue>];

  constructor(
    private readonly statement: StatementSync,
    bound: Params,
  ) {
    this.bound = normalizeParams(bound);
  }

  private params(params: Params) {
    return params.length > 0 ? normalizeParams(params) : this.bound;
  }

  async all<T = any[]>(...params: Params): Promise<T> {
    await yieldIfBusy();
    const rows = this.statement.all(...(this.params(params) as any[]));
    return rows.map((row) => toPlain(row)) as T;
  }

  async get<T = any>(...params: Params): Promise<T | undefined> {
    await yieldIfBusy();
    return toPlain<T | undefined>(
      this.statement.get(...(this.params(params) as any[])),
    );
  }

  async run(...params: Params): Promise<RunResult> {
    await yieldIfBusy();
    return toRunResult(this.statement.run(...(this.params(params) as any[])));
  }

  /** Statements are freed with the database; kept for API compatibility */
  async finalize(): Promise<void> {}
}

export class SqliteDatabase {
  private open = true;

  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the database file */
  static async open(filename: string): Promise<SqliteDatabase> {
    const { DatabaseSync } = loadNodeSqlite();
    const db = new DatabaseSync(filename, {
      // sqlite3 left foreign keys unenforced (SQLite's default); node:sqlite
      // enforces them. Core's fts_metadata declares a foreign key to the
      // FTS5 table that can't be enforced, so enforcing it fails every insert
      enableForeignKeyConstraints: false,
      // sqlite3 builds allow double-quoted string literals; keep accepting them
      enableDoubleQuotedStringLiterals: true,
    });
    return new SqliteDatabase(db);
  }

  async exec(sql: string): Promise<void> {
    await yieldIfBusy();
    this.db.exec(sql);
  }

  async run(sql: string, ...params: Params): Promise<RunResult> {
    await yieldIfBusy();
    return toRunResult(
      this.db.prepare(sql).run(...(normalizeParams(params) as any[])),
    );
  }

  async get<T = any>(sql: string, ...params: Params): Promise<T | undefined> {
    await yieldIfBusy();
    return toPlain<T | undefined>(
      this.db.prepare(sql).get(...(normalizeParams(params) as any[])),
    );
  }

  async all<T = any[]>(sql: string, ...params: Params): Promise<T> {
    await yieldIfBusy();
    const rows = this.db
      .prepare(sql)
      .all(...(normalizeParams(params) as any[]));
    return rows.map((row) => toPlain(row)) as T;
  }

  async prepare(sql: string, ...params: Params): Promise<SqliteStatement> {
    return new SqliteStatement(this.db.prepare(sql), params);
  }

  /**
   * Runs `fn` inside BEGIN/COMMIT and rolls back if it throws. `fn` is
   * synchronous, so no other caller's statements can run between BEGIN and
   * COMMIT.
   */
  async transaction<T>(fn: (tx: SqliteTransaction) => T): Promise<T> {
    await yieldIfBusy();
    const statements = new Map<string, StatementSync>();
    const tx: SqliteTransaction = {
      run: (sql, ...params) => {
        let statement = statements.get(sql);
        if (!statement) {
          statement = this.db.prepare(sql);
          statements.set(sql, statement);
        }
        return toRunResult(
          statement.run(...(normalizeParams(params) as any[])),
        );
      },
    };
    this.db.exec("BEGIN");
    let result: T;
    try {
      result = fn(tx);
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite already rolled back (e.g. after SQLITE_FULL); keep the
        // original error
      }
      throw e;
    }
    this.db.exec("COMMIT");
    return result;
  }

  async close(): Promise<void> {
    if (this.open) {
      this.open = false;
      this.db.close();
    }
  }
}
