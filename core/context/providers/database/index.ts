/**
 * Table schemas for the @database context provider. Replaces dbinfoz 0.14.0,
 * whose SQLite adapter needed the native sqlite3 package. Each adapter runs
 * dbinfoz's queries and returns the same shapes, so the context items stay
 * the same (checked against core/test/fixtures/regression/database).
 *
 * Unlike dbinfoz, every call opens its connection and closes it when done:
 * dbinfoz created a pool per lookup and never closed it.
 */
import { getMssqlTablesAndSchemas } from "./mssql";
import { getMysqlTablesAndSchemas } from "./mysql";
import { getPostgresTablesAndSchemas } from "./postgres";
import { getSqliteTablesAndSchemas } from "./sqlite";

export type DatabaseType = "postgres" | "mysql" | "sqlite" | "mssql";

/** Table name → that table's columns, in the engine's own shape */
export type TablesAndSchemas = Record<string, Record<string, unknown>>;

/**
 * The connection config from the user's config, passed to the driver
 * unchanged (as dbinfoz did): pg's PoolConfig, mysql2's PoolOptions, mssql's
 * config, or `{ filename }` for SQLite
 */
export type DatabaseConnectionConfig = Record<string, any>;

export async function getAllTablesAndSchemas(
  type: DatabaseType,
  connection: DatabaseConnectionConfig,
): Promise<TablesAndSchemas> {
  switch (type) {
    case "postgres":
      return getPostgresTablesAndSchemas(connection);
    case "mysql":
      return getMysqlTablesAndSchemas(connection);
    case "sqlite":
      return getSqliteTablesAndSchemas(connection);
    case "mssql":
      return getMssqlTablesAndSchemas(connection);
    default:
      throw new Error("Unsupported database type");
  }
}
