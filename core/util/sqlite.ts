/**
 * A small async wrapper over Node's built-in `node:sqlite`, with the subset of
 * the `sqlite` package API that core uses. It replaces `sqlite` + `sqlite3`,
 * whose native binary pulled in the deprecated `prebuild-install`.
 *
 * The file format doesn't depend on the driver, so databases written by
 * `sqlite3` open unchanged. Where node:sqlite behaves differently, this keeps
 * sqlite3's behavior:
 * - values are bound the way sqlite3 6 bound them (see `toSqlValue`);
 * - errors carry sqlite3's `SQLITE_<NAME>: <message>` text and `code`, which
 *   the indexer matches to tell corruption from a busy database;
 * - foreign keys stay unenforced and double-quoted string literals allowed.
 *
 * node:sqlite is synchronous: statements run on the calling thread, so every
 * call goes through one queue that gives the event loop a turn after
 * `YIELD_AFTER_MS` of continuous work (see `schedule`).
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

// Primary result codes (https://sqlite.org/rescode.html), by number
const SQLITE_CODE_NAMES: Record<number, string> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  12: "SQLITE_NOTFOUND",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  15: "SQLITE_PROTOCOL",
  16: "SQLITE_EMPTY",
  17: "SQLITE_SCHEMA",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  22: "SQLITE_NOLFS",
  23: "SQLITE_AUTH",
  24: "SQLITE_FORMAT",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
};

/**
 * A SQLite failure in sqlite3's shape: the message starts with the primary
 * code's name (`SQLITE_CONSTRAINT: UNIQUE constraint failed: t.v`) and
 * `code` is that name. node:sqlite reports every failure as
 * `ERR_SQLITE_ERROR` and keeps the result code only in `errcode`.
 */
export class SqliteError extends Error {
  /** Primary result code name, e.g. `SQLITE_BUSY` */
  readonly code: string;
  /** Primary result code, e.g. 5 */
  readonly errno: number;
  /** Extended result code, e.g. 2067 for a UNIQUE constraint */
  readonly errcode: number;

  constructor(cause: { message: string; errcode: number }) {
    const errno = cause.errcode & 0xff;
    const code = SQLITE_CODE_NAMES[errno] ?? `SQLITE_${errno}`;
    super(`${code}: ${cause.message}`, { cause });
    this.name = "SqliteError";
    this.code = code;
    this.errno = errno;
    this.errcode = cause.errcode;
  }
}

function toSqliteError(e: unknown): unknown {
  if (
    e instanceof Error &&
    !(e instanceof SqliteError) &&
    typeof (e as { errcode?: unknown }).errcode === "number"
  ) {
    return new SqliteError(e as Error & { errcode: number });
  }
  return e;
}

/** Runs a node:sqlite call, rethrowing its errors as SqliteError */
function call<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw toSqliteError(e);
  }
}

// Every call runs through one queue, and checks the time right before its
// statement runs. A run of calls that has held the thread for this long (a
// loop of awaited calls, or many calls started together with Promise.all)
// waits for the event loop to take a turn, so timers, I/O and IPC keep
// running
const YIELD_AFTER_MS = 20;
let busySince: number | undefined;
let queue: Promise<unknown> = Promise.resolve();

function markBusy() {
  if (busySince === undefined) {
    busySince = performance.now();
    // Runs as soon as the event loop gets a turn, which ends the busy run
    setImmediate(() => {
      busySince = undefined;
    });
  }
}

function schedule<T>(task: () => T): Promise<T> {
  const run = queue.then(async () => {
    markBusy();
    if (performance.now() - busySince! >= YIELD_AFTER_MS) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      markBusy();
    }
    return task();
  });
  queue = run.catch(() => {});
  return run;
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

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Binds a value the way sqlite3 6.0.1 did (recorded on an untyped column):
 * - integers that fit in 32 bits as INTEGER; other numbers, including larger
 *   integers such as `Date.now()`, as REAL (node:sqlite binds every number as
 *   REAL, so only the int32 case needs converting);
 * - Dates as REAL milliseconds since the epoch;
 * - booleans as 1/0 and `undefined` as NULL (node:sqlite rejects both).
 *
 * Columns declared INTEGER convert integral REALs back through type affinity,
 * as they did with sqlite3. BigInts bind as INTEGER (sqlite3 stored NULL; core
 * never binds one).
 */
function toSqlValue(value: SqlParam): SQLInputValue {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value ? 1n : 0n;
  }
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
      ? BigInt(value)
      : value;
  }
  if (value instanceof Date) {
    return value.getTime();
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

  private params(params: Params): any[] {
    return params.length > 0 ? normalizeParams(params) : this.bound;
  }

  all<T = any[]>(...params: Params): Promise<T> {
    return schedule(
      () =>
        call(() => this.statement.all(...this.params(params))).map((row) =>
          toPlain(row),
        ) as T,
    );
  }

  get<T = any>(...params: Params): Promise<T | undefined> {
    return schedule(() =>
      toPlain<T | undefined>(
        call(() => this.statement.get(...this.params(params))),
      ),
    );
  }

  run(...params: Params): Promise<RunResult> {
    return schedule(() =>
      toRunResult(call(() => this.statement.run(...this.params(params)))),
    );
  }

  /** Statements are freed with the database; kept for API compatibility */
  async finalize(): Promise<void> {}
}

export class SqliteDatabase {
  private isOpen = true;

  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (or creates) the database file */
  static async open(filename: string): Promise<SqliteDatabase> {
    const { DatabaseSync } = loadNodeSqlite();
    const db = call(
      () =>
        new DatabaseSync(filename, {
          // sqlite3 left foreign keys unenforced (SQLite's default);
          // node:sqlite enforces them. Core's fts_metadata declares a foreign
          // key to the FTS5 table that can't be enforced, so enforcing it
          // fails every insert
          enableForeignKeyConstraints: false,
          // sqlite3 builds allow double-quoted string literals
          enableDoubleQuotedStringLiterals: true,
        }),
    );
    return new SqliteDatabase(db);
  }

  exec(sql: string): Promise<void> {
    return schedule(() => call(() => this.db.exec(sql)));
  }

  run(sql: string, ...params: Params): Promise<RunResult> {
    return schedule(() =>
      toRunResult(
        call(() =>
          this.db.prepare(sql).run(...(normalizeParams(params) as any[])),
        ),
      ),
    );
  }

  get<T = any>(sql: string, ...params: Params): Promise<T | undefined> {
    return schedule(() =>
      toPlain<T | undefined>(
        call(() =>
          this.db.prepare(sql).get(...(normalizeParams(params) as any[])),
        ),
      ),
    );
  }

  all<T = any[]>(sql: string, ...params: Params): Promise<T> {
    return schedule(
      () =>
        call(() =>
          this.db.prepare(sql).all(...(normalizeParams(params) as any[])),
        ).map((row) => toPlain(row)) as T,
    );
  }

  async prepare(sql: string, ...params: Params): Promise<SqliteStatement> {
    return new SqliteStatement(
      call(() => this.db.prepare(sql)),
      params,
    );
  }

  /**
   * Runs `fn` between BEGIN and COMMIT, and rolls back if `fn` or the COMMIT
   * fails, so the connection is never left inside a transaction. `fn` is
   * synchronous, so no other caller's statements can run inside it; keep it
   * short, because it holds the write lock and the thread.
   */
  transaction<T>(fn: (tx: SqliteTransaction) => T): Promise<T> {
    return schedule(() => {
      const statements = new Map<string, StatementSync>();
      const tx: SqliteTransaction = {
        run: (sql, ...params) => {
          let statement = statements.get(sql);
          if (!statement) {
            statement = call(() => this.db.prepare(sql));
            statements.set(sql, statement);
          }
          return toRunResult(
            call(() => statement.run(...(normalizeParams(params) as any[]))),
          );
        },
      };
      call(() => this.db.exec("BEGIN"));
      try {
        const result = fn(tx);
        call(() => this.db.exec("COMMIT"));
        return result;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // SQLite already rolled back (e.g. after SQLITE_FULL); keep the
          // original error
        }
        throw toSqliteError(e);
      }
    });
  }

  close(): Promise<void> {
    return schedule(() => {
      if (this.isOpen) {
        this.isOpen = false;
        this.db.close();
      }
    });
  }
}
