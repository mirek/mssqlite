# @mssqlite/catalog

MSSQL system catalog (`sys.*`) emulation over SQLite, implementing the
[`sys` skill](../../.agents/skills/sys/SKILL.md) specification. Catalog views
are real SQLite tables (plus derived SQLite views) named `"sys.tables"`,
`"sys.columns"`, … — exactly the names [`@mssqlite/transpile`](../transpile)
produces for `sys.*` references, so transpiled catalog queries hit them with
no query interception.

## API

- `bootstrap(db, databaseName)` — creates backing tables, derived views
  (`sys.tables`, `sys.views`, `sys.procedures`, `sys.identity_columns`,
  `INFORMATION_SCHEMA.TABLES/COLUMNS`) and seed rows (schemas, all 31 system
  types, databases incl. the user database as id 5, database/server
  principals, object id allocator). Idempotent.
- DDL maintenance — called by the engine as DDL executes:
  - `createTable(db, ast)` — sys.objects (`U`), sys.columns with exact
    MSSQL type mapping (`system_type_id`, byte `max_length`,
    precision/scale, collation), identity extras, PK/UNIQUE constraint
    objects with backing `sys.indexes`/`sys.index_columns`, foreign keys
    with referential actions and column mappings, CHECK/DEFAULT constraint
    objects, heap rows.
  - `dropTable(db, name)` — removes the object and every dependent row.
  - `createIndex` / `dropIndex`, `createView` / `dropView`,
    `addColumns` / `dropColumns`.
- Lookups — `objectIdOf(db, name)` (schema-aware, case-insensitive),
  `tableColumns(db, objectId)` (the engine derives TDS column metadata from
  these rows), `schemaIdOf`, `allocateId`.
- `TypeRow.columnType(typeName)` — declared T-SQL type → sys.columns fields
  (`decimal(p,s)` wire lengths, `time/datetime2/datetimeoffset` scale
  lengths, `nvarchar` byte doubling, `max` → -1).

Object ids allocate from 100000001 via the `sys._next_id` counter, per the
skill's guidance.
