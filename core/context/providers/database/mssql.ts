/// <reference path="./mssql-module.d.ts" />
import type { DatabaseConnectionConfig, TablesAndSchemas } from "./index";

// The parts of the mssql package used here (it ships no type declarations)
interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query<T>(sql: string): Promise<{ recordset: T[] }>;
}

interface MssqlPool {
  connect(): Promise<MssqlPool>;
  request(): MssqlRequest;
  close(): Promise<void>;
}

interface Mssql {
  ConnectionPool: new (config: DatabaseConnectionConfig) => MssqlPool;
}

/** Column name → DATA_TYPE, for each base table in the database */
export async function getMssqlTablesAndSchemas(
  connection: DatabaseConnectionConfig,
): Promise<TablesAndSchemas> {
  const mssql = (await import("mssql")).default as unknown as Mssql;
  // dbinfoz replaced `options` with this, so other options were ignored
  const pool = new mssql.ConnectionPool({
    ...connection,
    options: { trustServerCertificate: true },
  });
  await pool.connect();
  try {
    const tables = await pool
      .request()
      .input("database", connection.database)
      .query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_CATALOG = @database;`,
      );
    const schemas: TablesAndSchemas = {};
    for (const { TABLE_NAME: table } of tables.recordset) {
      const columns = await pool
        .request()
        .input("tableName", table)
        .query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
          `SELECT COLUMN_NAME, DATA_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @tableName;`,
        );
      schemas[table] = {};
      for (const row of columns.recordset) {
        schemas[table][row.COLUMN_NAME] = row.DATA_TYPE;
      }
    }
    return schemas;
  } finally {
    await pool.close();
  }
}
