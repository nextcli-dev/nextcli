import { SqliteDatabase } from "../../../util/sqlite";

import type { DatabaseConnectionConfig, TablesAndSchemas } from "./index";

/** Column name → { type, nullable, default, primaryKey }, from PRAGMA table_info */
export async function getSqliteTablesAndSchemas(
  connection: DatabaseConnectionConfig,
): Promise<TablesAndSchemas> {
  const db = await SqliteDatabase.open(connection.filename);
  try {
    const tables = await db.all<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
    );
    const schemas: TablesAndSchemas = {};
    for (const { name: table } of tables) {
      // dbinfoz interpolated the name unquoted; quoting keeps names with
      // spaces or keywords working and gives the same result otherwise
      const columns = await db.all<
        {
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }[]
      >(`PRAGMA table_info("${table.replace(/"/g, '""')}");`);
      schemas[table] = {};
      for (const { name, type, notnull, dflt_value, pk } of columns) {
        schemas[table][name] = {
          type,
          nullable: notnull === 0,
          default: dflt_value,
          primaryKey: pk !== 0,
        };
      }
    }
    return schemas;
  } finally {
    await db.close();
  }
}
