---
name: sqlite
description: "Comprehensive SQLite reference for implementing an MSSQL-compatible server on top of SQLite. Covers SQL syntax, type affinity and STRICT tables, DDL (CREATE/ALTER/DROP TABLE/INDEX/VIEW/TRIGGER, FKs, generated columns), DML (INSERT/UPDATE/DELETE/UPSERT/REPLACE, ON CONFLICT, RETURNING), SELECT (joins, CTEs, window functions, set ops, row values, EXPLAIN), built-in scalar/aggregate/date/math/printf functions, PRAGMAs (journal_mode, foreign_keys, busy_timeout, defer_foreign_keys, etc.), transactions and SAVEPOINTs, WAL mode and locking semantics, indexes and the query planner (partial/expression indexes, ANALYZE, EXPLAIN QUERY PLAN), JSON1/FTS5/RTree/virtual-table extensions, and limits/quirks that diverge from T-SQL. Use when designing the SQL-translation layer, schema bootstrap, transaction model, or compatibility behaviors of the server."
---

# SQLite Reference

Complete reference for SQLite 3.53.x, scoped to building a SQLite-backed MSSQL-compatible server. Synthesized from the official SQLite documentation snapshot (sqlite-doc-3530100).

Source: [sqlite.org/docs](https://sqlite.org/docs.html)

## Reference Files

- [syntax.md](syntax.md) — Lexical structure (identifiers, all four quoting styles incl. `[brackets]`, reserved keywords), literals (string, blob `X'...'`, numeric, NULL, TRUE/FALSE, CURRENT_*), bind parameters (`?`/`?NNN`/`:name`/`@name`/`$name`), operators and precedence, expression forms (CAST, COLLATE, CASE, IN/EXISTS, subqueries, COALESCE/NULLIF/IFNULL/IIF), three-valued NULL logic, name resolution and T-SQL three/four-part name mapping
- [data-types.md](data-types.md) — Storage classes (NULL/INTEGER/REAL/TEXT/BLOB), the 5-rule affinity-determination algorithm, insert/comparison/arithmetic coercion, INTEGER PRIMARY KEY rowid alias quirks, STRICT tables (`ANY` type, `SQLITE_CONSTRAINT_DATATYPE`), date/time storage conventions, BOOLEAN representation, REAL precision (binary64), collations (BINARY/NOCASE/RTRIM), NULL semantics incl. UNIQUE divergence from MSSQL, T-SQL→SQLite type map
- [ddl.md](ddl.md) — CREATE TABLE (column-def, constraints, WITHOUT ROWID, STRICT, IF NOT EXISTS, CTAS), AUTOINCREMENT vs rowid alias, ALTER TABLE supported ops + 12-step rebuild workaround, DROP, CREATE INDEX (UNIQUE/partial/expression/COLLATE/DESC), CREATE VIEW + INSTEAD OF triggers, CREATE TRIGGER (BEFORE/AFTER/INSTEAD OF, NEW/OLD, RAISE), CREATE VIRTUAL TABLE, foreign keys (enable via PRAGMA, actions, RESTRICT vs NO ACTION timing, DEFERRABLE), `sqlite_schema` introspection, ON CONFLICT actions (ROLLBACK/ABORT/FAIL/IGNORE/REPLACE)
- [dml.md](dml.md) — INSERT (VALUES multi-row, SELECT, DEFAULT VALUES, OR `<action>`), UPDATE (row-value SET, multi-table via FROM with PostgreSQL semantics — contrasted with T-SQL), DELETE (truncate optimization), UPSERT (`ON CONFLICT (target) DO NOTHING/DO UPDATE SET excluded.col`), REPLACE (incl. trigger/FK side effects), RETURNING (scope, ordering, restrictions), INDEXED BY / NOT INDEXED, conflict-action precedence
- [queries.md](queries.md) — SELECT grammar, DISTINCT/ALL, table-star, JOIN types (CROSS/INNER/LEFT/RIGHT/FULL/NATURAL/USING/ON, RIGHT+FULL since 3.39), GROUP BY / HAVING with SQLite's bare-column relaxation, ORDER BY (NULLS FIRST/LAST, COLLATE precedence), LIMIT/OFFSET both forms, compound SELECTs (UNION/INTERSECT/EXCEPT), subqueries, row values, VALUES as row source, CTEs (recursive, MATERIALIZED/NOT MATERIALIZED), window functions (full frame-spec incl. ROWS/RANGE/GROUPS, EXCLUDE, named windows), EXPLAIN vs EXPLAIN QUERY PLAN, table-valued functions
- [functions.md](functions.md) — Built-in scalar functions (`abs`, `coalesce`, `concat`, `format`/`printf`, `glob`, `hex`/`unhex`, `iif`, `instr`, `length`, `lower`/`upper`, `quote`, `random`/`randomblob`, `replace`, `round`, `substr`, `trim`/`ltrim`/`rtrim`, `typeof`, `unicode`, `zeroblob`, etc.), date/time (`date`/`time`/`datetime`/`julianday`/`unixepoch`/`strftime`/`timediff` + all modifiers), math (built-in default in node:sqlite), aggregates (`count`/`sum`/`total`/`avg`/`min`/`max`/`group_concat`/`string_agg` with FILTER/DISTINCT/ORDER BY), printf format specifiers, T-SQL gap callouts
- [pragmas.md](pragmas.md) — Concurrency/durability (`journal_mode`=WAL, `synchronous`, `wal_autocheckpoint`, `busy_timeout`, `locking_mode`), FK/triggers/constraints (`foreign_keys`, `defer_foreign_keys`, `recursive_triggers`, `trusted_schema`), memory/caching (`cache_size`, `page_size`, `mmap_size`, `temp_store`), schema introspection (`table_list`/`table_info`/`index_list`/`foreign_key_list`, `pragma_*` table-valued functions for information_schema emulation), planner (`optimize`, `analysis_limit`, `automatic_index`), debug/safety, plus connection bootstrap recipe for an MSSQL-compat server
- [transactions.md](transactions.md) — BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE], COMMIT/ROLLBACK, SAVEPOINT/RELEASE/ROLLBACK TO nesting, autocommit, isolation model (snapshot per-connection in WAL, serializable in rollback mode), locking-state lifecycle (UNLOCKED→SHARED→RESERVED→PENDING→EXCLUSIVE), WAL reader/writer concurrency, checkpoint modes (PASSIVE/FULL/RESTART/TRUNCATE), `SQLITE_BUSY`/`SQLITE_BUSY_SNAPSHOT` handling, deferred FK behavior, server-design recommendations
- [optimizer.md](optimizer.md) — Index types (rowid B-tree, `sqlite_autoindex_*`, user, automatic), multi-column left-prefix + gap + inequality cutoff rules, covering indexes, partial-index usability (W⇒X rules), expression indexes (textual match + REINDEX EXPRESSIONS), ANALYZE (`sqlite_stat1`/`sqlite_stat4`, `PRAGMA optimize` with mask `0x10002`), join-reorder cost model, WHERE-term shapes, OR optimizations (OR→IN, MULTI-INDEX OR), LIKE/GLOB optimization preconditions, skip-scan, sort elision, subquery flattening, EXPLAIN QUERY PLAN reading guide (SCAN/SEARCH/USING [COVERING] INDEX/CO-ROUTINE/MATERIALIZE), bad-plan diagnostic checklist
- [extensions.md](extensions.md) — Virtual tables (concept, eponymous, table-valued functions), JSON1 (scalars, `->`/`->>`, JSONB variants, `json_each`/`json_tree`, aggregates), FTS5 (CREATE syntax, MATCH, ranking), R*Tree, `generate_series`, `carray` (host-language array binding ≈ TVP), CSV, spellfix1, dbstat/bytecodevtab introspection, sessions/changesets overview; T-SQL mapping notes (JSON_VALUE/OPENJSON, CONTAINS/FREETEXT, change tracking)
- [limits-and-quirks.md](limits-and-quirks.md) — Numeric limits (`SQLITE_MAX_LENGTH`, columns, JOIN count 64 vs 256, expression depth, trigger recursion), flexible typing without STRICT, FK off by default, PK allows NULL bug, INTEGER PRIMARY KEY = ROWID, AUTOINCREMENT vs IDENTITY, REPLACE vs MERGE, single-writer concurrency, no procedures/auth, GROUP BY relaxation, CAST gotchas, BINARY collation, double-quoted-string misfeature, ALTER TABLE limits, omitted features (MERGE, PIVOT, OUTPUT, RAISERROR), corruption risks, T-SQL isolation-hint mapping

## Quick start for the server

Connection bootstrap (apply on every checkout — see `pragmas.md`):

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
PRAGMA trusted_schema = OFF;
```

Per-transaction (when emulating T-SQL deferred-constraint semantics):

```sql
PRAGMA defer_foreign_keys = ON;
```

Default to `BEGIN IMMEDIATE` for any write transaction to avoid `SQLITE_BUSY_SNAPSHOT` mid-transaction (see `transactions.md`).

## How mssqlite uses SQLite (implemented)

The translation layer ([`packages/transpile`](../../../packages/transpile))
and engine ([`packages/engine`](../../../packages/engine)) rely on:

- **`COLLATE NOCASE` on char/text columns** for MSSQL's case-insensitive
  default collation — comparisons and UNIQUE constraints follow the
  column collation; LIKE is ASCII-case-insensitive anyway.
- **`INTEGER PRIMARY KEY AUTOINCREMENT`** as the IDENTITY mapping
  (never-reused ids); TRUNCATE deletes the `sqlite_sequence` row to reset.
- **Native functions**: `concat`/`concat_ws` (NULL-as-empty matches
  T-SQL CONCAT), `iif`, math functions (`ceiling`, `power`, `ln`,
  `log10`, `atan2`, …), window functions, `group_concat(x, sep)` for
  STRING_AGG, `char`, `unicode`, `instr`, `substr`, partial indexes for
  filtered indexes, `UPDATE ... FROM` for T-SQL update-joins.
- **`@name` bind parameters** so T-SQL variables pass through unrenamed.
- **Application-defined functions** (`mssqlite_*`) for everything else —
  date arithmetic with MSSQL boundary semantics, PATINDEX, dynamic `+`.
- **Expressions in DEFAULT clauses** — `DEFAULT (strftime(...))` for
  `DEFAULT GETDATE()`.
- Dotted object names inside quoted identifiers (`"sys.tables"`,
  `"app.users"`) to flatten MSSQL schemas without query interception,
  and the `temp` schema for `#temp` tables.
- Current engine deviation from the bootstrap recipe above: single shared
  connection per server with plain `BEGIN` (sync API, single process) —
  revisit WAL + IMMEDIATE if a multi-connection engine lands.

## What's NOT covered

- The C API (`sqlite3_*`) — use [node-sqlite](../node-sqlite/SKILL.md) for the JS-facing surface.
- File-format internals, recovery, atomic-commit byte-level details, the source code organization.
- Tcl bindings, the CLI shell, build/compile instructions.
- Historical version notes and release logs.
