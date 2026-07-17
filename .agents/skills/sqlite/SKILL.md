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
- [limits-and-quirks.md](limits-and-quirks.md) — Numeric limits (`SQLITE_MAX_LENGTH`, columns, JOIN count 64 vs 256, expression depth, trigger recursion), flexible typing without STRICT, FK off by default, PK allows NULL bug, INTEGER PRIMARY KEY = ROWID, AUTOINCREMENT vs IDENTITY, REPLACE vs MERGE, single-writer concurrency, no procedures/auth, GROUP BY relaxation, CAST gotchas, BINARY collation, double-quoted-string misfeature, ALTER TABLE limits, omitted features (MERGE, OUTPUT, RAISERROR), corruption risks, T-SQL isolation-hint mapping

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
- **Application-enforced character widths** because SQLite TEXT affinity does
  not enforce varchar lengths. Transpiled explicit conversions call a
  truncating character UDF; DML/default/computed and bulk storage call a
  rejecting UDF before binding. Both use Windows-1252 bytes for non-Unicode
  families and UTF-16LE code units for Unicode families.
- **Ordinary typed columns for IDENTITY storage** — allocation belongs to the
  engine's database registry, not SQLite rowid/AUTOINCREMENT. UDF expressions
  reserve generated values during INSERT/MERGE evaluation so failed statements
  leave gaps; TRUNCATE resets engine state transactionally.
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
- Each SQL database owns a primary `DatabaseSync` and independent catalog.
  Every primary attaches the other stores under encoded aliases, so
  cross-database DML shares one SQLite transaction. Cross-file crash atomicity
  requires disk-backed `main` with rollback journaling; it is not guaranteed
  for in-memory `main` or WAL. SQLite's ten-attachment limit caps mssqlite at
  eleven logical databases. Cross-database DDL switches to the target primary
  and is rejected during user transactions.
- Table variables use unique tables in the SQLite `temp` schema. Their names
  stay out of the catalog; the engine keeps the T-SQL column definitions for
  result metadata and drops each backing table at batch/procedure scope exit.
  Current divergence: their DML shares the surrounding SQLite transaction,
  while SQL Server table-variable updates survive user transaction rollback.
- Built-in T-SQL table-valued functions lean on JSON1: `STRING_SPLIT` feeds
  an adapter-produced JSON array to `json_each`, while `OPENJSON` feeds
  source-spanned default-schema rows or exact WITH-row slices to `json_each`.
  Column adapter UDFs apply SQL Server BIN2-like lax/strict paths before SQLite
  casts the declared output types. Node's bundled SQLite does not expose the optional
  `generate_series` virtual table, so `GENERATE_SERIES` renders as a
  streaming recursive CTE with SQL Server's direction-sensitive default step.
- Do not use JSON1 scalar extraction for JSON_VALUE/JSON_QUERY compatibility:
  `json_extract` returns SQLite numeric types and normalizes object/array text.
  mssqlite instead parses source-spanned nodes, returning lexical scalar text
  or the exact selected fragment while enforcing SQL Server lax/strict errors
  and JSON_VALUE's 4000 UTF-16-unit ceiling. OPENJSON shares that reader for
  root and WITH-column paths while retaining `json_each` as its row source.
- SQLite has no general LATERAL keyword, but eponymous virtual-table function
  arguments can reference earlier FROM sources. mssqlite uses that for
  correlated STRING_SPLIT APPLY; correlated TOP (1) derived sources instead
  lower to a ROW_NUMBER-partitioned INNER/LEFT join.
- T-SQL VALUES table sources wrap native SQLite VALUES in an outer SELECT that
  renames generated `columnN` fields. Engine resolution first infers SQL Server
  common types and validates the row/alias shape; transpilation explicitly
  coerces each cell before rendering. This avoids SQLite's compound-SELECT term
  limit and works in FROM, joins, CTE queries, uncorrelated APPLY, and MERGE.
- SQLite has no PIVOT/UNPIVOT operators. mssqlite renders PIVOT as grouped
  aggregates over `CASE WHEN pivot_key = value THEN aggregate_value END`.
  UNPIVOT becomes a `MATERIALIZED` CTE plus one NULL-filtered `UNION ALL`
  term per source column, ensuring volatile source expressions run once.
  SQLite's dynamic affinity can carry mixed numeric values in direct
  rendering, but engine execution rejects differing known declared types to
  retain SQL Server's stable result metadata.
- SQLite NUMERIC affinity and native numeric aggregates are not used for
  DECIMAL/NUMERIC: columns have TEXT affinity and contain canonical fixed-scale
  strings. Scalar and aggregate UDFs perform scaled-BigInt operations; a
  sortable decimal key UDF replaces lexical TEXT ordering.
- Opaque special types keep identity outside SQLite affinity: `xml` is Unicode
  TEXT, CLR `hierarchyid`/`geometry`/`geography` values are native serialized
  BLOBs, and `sql_variant` is a BLOB containing its TDS base-type envelope.
  Target-column DML injects cast UDFs before binding, so a number or string
  cannot be affinity-coerced into an indistinguishable value. Variant casts
  unpack the envelope; special-type operators and methods are rejected before
  SQLite sees them.
- SQLite has no offset-preserving temporal storage class. mssqlite stores
  `datetimeoffset(n)` as canonical fixed-scale TEXT containing local civil
  time and `±HH:MM`, and uses `mssqlite_datetimeoffset_key` (UTC day plus
  100ns ticks) for comparison, IN/BETWEEN, ORDER BY, UNIQUE constraints, and
  explicit expression indexes. Inserts, updates, defaults, and typed variables
  are passed through `mssqlite_datetimeoffset_cast` so affinity cannot discard
  the offset or fractional precision. Do not use SQLite `datetime()` or
  `julianday()` for this type: they normalize/format with lower precision and
  cannot retain the original offset.
- SQLite `date()` and `strftime()` may normalize impossible civil dates and
  therefore are not conversion validators. Ordinary T-SQL date/time casts and
  declared storage use `mssqlite_temporal_cast` / `mssqlite_implicit_temporal`,
  which round-trip year/month/day through proleptic civil-day math, validate
  time ranges, raise 241, and return NULL for TRY conversions. FROMPARTS
  constructors use separate NULL-propagating UDFs and raise 289 for invalid
  component ranges.
- T-SQL computed columns lower to `GENERATED ALWAYS AS`: VIRTUAL for ordinary
  definitions and STORED for PERSISTED. CREATE supports both; SQLite permits
  ALTER TABLE ADD only for VIRTUAL generated columns. Expressions may reference
  columns in the same row and deterministic scalar functions, but not
  subqueries, aggregates, window functions, or nondeterministic callbacks.
  Exact decimal and checked integer generated expressions use separately
  registered deterministic UDF names so SQLite accepts them in schema DDL.
- SQLite cannot alter a column declaration in place. ALTER COLUMN captures the
  physical CREATE TABLE plus dependent indexes/triggers/views, creates a
  replacement table with the changed member, inserts through the target T-SQL
  storage cast, swaps names, recreates dependencies, updates `sys.columns`, and
  runs `foreign_key_check` inside one savepoint. Incoming foreign keys require
  temporarily disabling enforcement outside the savepoint; the operation is
  rejected inside a user transaction when that pragma transition is required.
- Node's `node:sqlite` API cannot register custom SQLite collations. mssqlite
  therefore declares BINARY/NOCASE as a baseline and renders supported SQL
  Server collations through a deterministic normalization-key UDF. Predicates,
  IN/BETWEEN, joins, ORDER/GROUP BY, DISTINCT aggregates/projections,
  UNION/EXCEPT/INTERSECT, expression indexes, and supplemental UNIQUE indexes
  all use the identical effective-or-default key, preserving CI/CS, AI/AS and
  BIN2 behavior. Accent-insensitive keys use Unicode NFD with combining marks
  removed; only trailing U+0020 spaces are ignored as SQL comparison padding.
  The original value is projected from grouped/set wrappers, so normalization
  does not leak into client rows. LIKE remains on its dedicated matcher. Native
  SQLite foreign keys cannot call a UDF, so text-bearing foreign keys omit the
  native clause and install persistent triggers for child validation and parent
  NO ACTION/CASCADE/SET NULL/SET DEFAULT behavior over the same key.
- SQLite UNIQUE indexes treat NULLs as distinct, unlike SQL Server. mssqlite
  expands each nullable logical key `k` to `(k IS NULL), ifnull(k, 0)` in a
  unique expression index. The flag separates real values from the arbitrary
  sentinel, while `k` may itself be a collation, exact-decimal, or temporal key
  expression. CREATE TABLE constraints keep their native definition plus a
  reserved supplemental index (2627); explicit unique indexes use the expanded
  key directly (2601). Partial-index WHERE predicates remain unchanged.
- SQLite has no ROLLUP, CUBE, GROUPING SETS, or GROUPING function. mssqlite
  expands them into one ordinary GROUP BY query per grouping set joined by
  UNION ALL, replacing omitted keys with NULL and GROUPING calls with branch
  constants. A MATERIALIZED CTE evaluates simple sources once; duplicate
  explicit sets remain separate branches as SQL Server requires.
- FOR JSON uses SQLite JSON1 construction rather than string concatenation:
  per-row `json_object`/`json_patch` preserves escaping and optional NULLs,
  `json_group_array` produces the outer array, and `json()` marks JSON_QUERY
  or nested FOR JSON fragments after subquery boundaries. Empty PATH/AUTO
  results coalesce to `[]`; WITHOUT_ARRAY_WRAPPER uses comma concatenation
  and, like SQL Server, is only valid JSON for a single row.
- Persisted scalar user functions are not SQLite schema functions: the engine
  registers varargs callbacks by final name and interprets the stored T-SQL
  body in an isolated scope. Inline TVFs substitute argument expressions into
  their stored SELECT AST and become derived sources; correlated simple forms
  lower to ordinary equality joins because SQLite lacks general LATERAL.
- SQL Server DML triggers are not mapped to SQLite `CREATE TRIGGER`: SQLite
  fires once per row and exposes only scalar OLD/NEW values. The engine wraps
  each triggering statement in a savepoint, captures full affected rowsets
  with RETURNING plus an UPDATE pre-image snapshot, materializes temp
  `inserted`/`deleted` tables, and interprets the stored T-SQL body once.
  INSTEAD OF operations build intended images without mutating the base table.
- Rowversion is the deliberate internal exception to that rule. Its physical
  BLOB column remains nullable so an AFTER INSERT trigger can replace the
  transient NULL; an AFTER UPDATE trigger detects unchanged OLD/NEW versions
  for MERGE, cascades, and other indirect writes. Normal engine DML supplies
  the value directly so SQLite RETURNING sees it. Both triggers call a
  nondeterministic UDF backed by a synchronous server-wide unsigned counter;
  persisted decimal-text state flushes only outside user transactions, so a
  SQLite rollback does not reuse an allocated version.
- SQLite has no schema sequence generator. mssqlite persists definitions and
  allocation state as catalog rows, advances a synchronous database-wide BigInt
  registry from a nondeterministic UDF, and flushes it only outside SQLite user
  transactions so SQL Server-style rollback-independent consumption survives.
- SQLite returns NULL for division/modulo by zero and promotes overflowing
  integer scalar arithmetic. mssqlite therefore renders checked arithmetic UDFs
  that evaluate operands once and raise SQL Server 8134/8115 (or NULL only under
  ARITHABORT OFF + ANSI_WARNINGS OFF). Custom SUM and integer AVG aggregates
  check int/bigint accumulator widths instead of waiting for SQLite's
  signed-64-bit overflow; AVG divides exact sum/count state toward zero and
  supplies an inverse callback for window use rather than SQLite's REAL avg().
- SQLite compares mixed storage classes by its own class ordering and numeric
  affinity may convert invalid text to zero. mssqlite therefore infers the
  higher-precedence T-SQL type before rendering predicates, CASE/IN/BETWEEN,
  compound SELECTs, and VALUES, then calls strict conversion UDFs. Target DML
  and MERGE assignments use the same category conversions before storage.
- SQLite LIKE lacks T-SQL bracket classes and Unicode collation behavior.
  mssqlite therefore compiles every LIKE pattern in a UDF after applying the
  effective SQL collation, including ranges, negated classes, ESCAPE, and the
  trailing-source-space alternative required by SQL Server.
- SQLite length/substr and JavaScript iteration use code points where SQL
  Server's non-SC collations use UTF-16 units. Dedicated UDFs use JS code-unit
  indexing. Lone-surrogate results cross SQLite as raw UTF-16LE BLOBs because
  SQLite TEXT replaces them, then the engine decodes them after metadata is
  known so TDS retains the exact two-byte unit.
- Current engine deviation from the bootstrap recipe above: single shared
  connection per server with plain `BEGIN` (sync API, single process) —
  revisit WAL + IMMEDIATE if a multi-connection engine lands.

## What's NOT covered

- The C API (`sqlite3_*`) — use [node-sqlite](../node-sqlite/SKILL.md) for the JS-facing surface.
- File-format internals, recovery, atomic-commit byte-level details, the source code organization.
- Tcl bindings, the CLI shell, build/compile instructions.
- Historical version notes and release logs.

## Differential backlog

Native SQLite shortcuts that still leak through the T-SQL compatibility
boundary are tracked in [TODO.md](../../../TODO.md). The current SQL Server
2025 differentials cover text comparison/collation and result metadata; the
OPENJSON path, scalar JSON, and typed SELECT INTO contracts from that audit are
implemented.
