import type { DatabaseConnectionConfig, TablesAndSchemas } from "./index";

/** Column name → { type, nullable, key, default }, from DESCRIBE */
export async function getMysqlTablesAndSchemas(
  connection: DatabaseConnectionConfig,
): Promise<TablesAndSchemas> {
  const mysql = (await import("mysql2/promise")).default;
  const pool = mysql.createPool(connection);
  try {
    await pool.query(`USE ${mysql.escapeId(connection.database)};`);
    const [tables] = await pool.query("SHOW TABLES;");
    const schemas: TablesAndSchemas = {};
    for (const row of tables as Record<string, string>[]) {
      const table = row[Object.keys(row)[0]];
      const [columns] = await pool.query(`DESCRIBE ${mysql.escapeId(table)};`);
      schemas[table] = {};
      for (const column of columns as Record<string, any>[]) {
        schemas[table][column.Field] = {
          type: column.Type,
          nullable: column.Null === "YES",
          key: column.Key,
          default: column.Default,
        };
      }
    }
    return schemas;
  } finally {
    await pool.end();
  }
}
