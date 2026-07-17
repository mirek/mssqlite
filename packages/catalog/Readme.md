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
  principals, object id allocator). The 34 rows include CLR assembly types
  hierarchyid/geometry/geography with distinct user ids over system type 240.
  Idempotent.
- DDL maintenance — called by the engine as DDL executes:
  - `createTable(db, ast)` — sys.objects (`U`), sys.columns with exact
    MSSQL type mapping (`system_type_id`, byte `max_length`,
    precision/scale, collation), identity extras, PK/UNIQUE constraint
    objects with backing `sys.indexes`/`sys.index_columns`, foreign keys
    with referential actions and column mappings, CHECK/DEFAULT constraint
    objects, heap rows.
  - `dropTable(db, name)` — removes the object and every dependent row.
  - `createIndex` / `dropIndex`, `createView` / `dropView`,
    `createProcedure` / `dropProcedure`, and scalar/inline-TVF
    `createFunction` / `dropFunction`, and `createTrigger` / `dropTrigger`;
    module definitions persist in `sys.sql_modules`, functions use
    sys.objects type `FN` / `IF`, and triggers use table-parented type `TR`;
    `createSequence` / `alterSequence` / `dropSequence` maintain `SO` objects
    and lossless counter state behind `sys.sequences`;
    rowversion/TIMESTAMP columns use type id 189 and the database-wide counter
    persists as decimal text in the singleton `sys.rowversion_state` table;
    computed columns populate `is_computed` plus definition/persistence rows
    behind `sys.computed_columns`; `addColumns` / `dropColumns`.
  - `rename(db, oldName, newName, kind)` uses a savepoint to rename a physical
    SQLite table/view, column, or user index together with its `sys.objects`,
    `sys.columns`, or `sys.indexes` identity. A failure rolls both layers back.
- Lookups — `objectIdOf(db, name)` (schema-aware, case-insensitive),
  `tableColumns(db, objectId)` (the engine derives TDS column metadata from
  these rows), `schemaIdOf`, `allocateId`.
- `TypeRow.columnType(typeName)` — declared T-SQL type → sys.columns fields
  (`decimal(p,s)` wire lengths, `time/datetime2/datetimeoffset` scale
  lengths, `nvarchar` byte doubling, `max` → -1).
  Opaque sql_variant/XML/CLR declarations retain ids 98/241/240 and the CLR
  user type id needed to select native UDT result metadata.
  Per-column COLLATE names override the type default in `collation_name` and
  are later translated to TDS collation bytes by engine metadata.

Object ids allocate from 100000001 via the `sys._next_id` counter, per the
skill's guidance.
