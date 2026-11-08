---
name: Migration Safety
description: Catch SQLite schema changes that break or lose data in existing user databases
paths:
  - "core/util/sqlite.ts"
  - "core/indexing/**"
  - "core/autocomplete/util/AutocompleteLruCache.ts"
  - "**/*.sql"
---

NextCLI has no migration framework. SQLite databases (through `node:sqlite`) live on users' machines, and their schemas are created and upgraded in code with `CREATE TABLE`, `ALTER TABLE` and `PRAGMA user_version`. A user who upgrades keeps their old database, and nothing rolls back. Review only schema-related code changed in this pull request. Flag:

- A changed `CREATE TABLE` with no upgrade path for a database that already has the old table. `CREATE TABLE IF NOT EXISTS` does nothing on an existing table, so new columns or constraints never appear there.
- A new column added as `NOT NULL` without a `DEFAULT`, or a narrowed column type, on a table that may already hold rows.
- `DROP TABLE`, `DROP COLUMN` or a table rebuild that deletes user data without copying it first, when that data cannot be rebuilt by re-indexing.
- Code that reads a renamed or removed column or table without handling databases still on the old schema.
- A new foreign key. Foreign keys are on by default in `node:sqlite`, so existing rows that violate it make inserts or deletes fail.
- Large synchronous queries or migrations on the extension host's main thread. `node:sqlite` blocks the event loop.
- Use of FTS5 without handling Node versions before 22.16, which don't have it.

Index caches that are safe to drop and rebuild are fine to recreate; say so instead of flagging them. If the pull request changes no schema, return PASS.
