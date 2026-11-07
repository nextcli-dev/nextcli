import type { DatabaseConnectionConfig, TablesAndSchemas } from "./index";

/** Column name → data_type, for each table in the public schema */
export async function getPostgresTablesAndSchemas(
  connection: DatabaseConnectionConfig,
): Promise<TablesAndSchemas> {
  const { Pool } = (await import("pg")).default;
  const pool = new Pool(connection);
  try {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_catalog = $1;`,
      [connection.database],
    );
    const schemas: TablesAndSchemas = {};
    for (const { table_name: table } of tables.rows) {
      // Not filtered by schema, as in dbinfoz: a table with the same name in
      // another schema adds its columns too
      const columns = await pool.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name = $1;`,
        [table],
      );
      schemas[table] = {};
      for (const row of columns.rows) {
        schemas[table][row.column_name] = row.data_type;
      }
    }
    return schemas;
  } finally {
    await pool.end();
  }
}
