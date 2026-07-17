# @mssqlite/engine

T-SQL execution engine over `node:sqlite`. Parses batches with
[`@mssqlite/tsql`](../tsql), renders SQL with
[`@mssqlite/transpile`](../transpile), maintains the
[`@mssqlite/catalog`](../catalog), and interprets what SQLite can't run —
variables, table variables, control flow, transactions, procedures, and
statement-level DML triggers.

## API

```ts
import { server, session, executeBatch } from '@mssqlite/engine'

const srv = server({ path: ':memory:', databaseName: 'master' })
const s = session(srv)
const items = executeBatch(s, `
  DECLARE @x INT = 1
  SELECT @x + 1 AS n
`)
// items → [ { kind: 'rows', columns: [ { name: 'n', typeInfo, nullable } ], rows: [ [ 2 ] ], rowCount: 1 } ]
```

- `server(options)` — opens the SQLite database, bootstraps the catalog and
  registers every `mssqlite_*` UDF the transpiler emits. One server hosts
  many sessions and one SQLite store/primary handle per SQL database.
- `session(server)` — per-connection state: declared variables, SET
  options, `@@ROWCOUNT` / `@@IDENTITY` / `@@TRANCOUNT` / `@@ERROR`, spid,
  and a synchronized `sys.dm_exec_sessions` row. Outermost batches expose a
  live request row until completion; `closeSession` removes disconnected state.
- `executeBatch(session, sql)` — items: `rows` (with TDS column metadata),
  `count`, `message`, and ordered recoverable `error` entries. Throws
  `BatchError` after a mixed-error batch (retaining all produced items) or
  `MssqlError` for compile/batch-aborting failures, with MSSQL number, severity
  and state (208 invalid object, 2627 unique violation, 547 FK/CHECK,
  515 not null, 102 syntax, 137 undeclared variable, …).
- `executeSql(session, sql, parameters)` — `sp_executesql` semantics:
  parameters bind as scoped variables, OUTPUT values return.
- `executeBatchAsync(session, sql, control)` / `executeSqlAsync(session, sql,
  parameters, control)` — AbortSignal-aware server execution. These APIs yield
  at statement and interpreted control-flow boundaries; cancellation throws
  `CancellationError` without turning it into a SQL error item.
- `evaluate(session, expression)` — scalar evaluation used for DECLARE
  initializers, SET, IF/WHILE conditions and PRINT.
- `prepareBulkLoad` / `beginBulkLoad` / `writeBulkRows` /
  `finishBulkLoad` / `abortBulkLoad` — validate an `INSERT BULK` setup,
  bind wire metadata to catalog columns, stream decoded rows through cached
  SQLite statements under one savepoint, and commit or roll back the request.

## Interpretation

- **DECLARE / SET / SELECT @x = …** — scalar variables live in the session,
  bound as native SQLite parameters. Assignment SELECTs return no result
  set and assign from the last row, as MSSQL does.
- **DECLARE @t TABLE (…)** — allocates a collision-free SQLite temp table
  for the active batch or procedure scope. SELECT/INSERT/UPDATE/DELETE and
  OUTPUT INTO references resolve through that scope; nested procedures and
  dynamic batches get isolated scopes, and every backing table is dropped
  when its declaring scope exits, including on errors.
- **Table-valued functions** — SELECT sources support `STRING_SPLIT`,
  `OPENJSON` (default and explicit WITH schemas), and `GENERATE_SERIES`.
  Small scalar adapters validate splitting, JSON paths, and series arguments;
  SQLite `json_each` and a streaming recursive CTE produce the rows. OPENJSON
  shares the source-spanned JSON reader with the scalar functions, including
  BIN2-like lax/strict root and column paths and exact JSON fragments.
- **CROSS / OUTER APPLY** — supported for correlated two-argument
  STRING_SPLIT, correlated OPENJSON, and simple correlated TOP (1) derived
  queries. CROSS removes empty right sides; OUTER retains the left row with
  NULL right columns.
- **PIVOT / UNPIVOT** — source schemas are resolved before transpilation so
  conditional-aggregate PIVOT and materialized `UNION ALL` UNPIVOT rewrites
  can validate names and emit stable generated-column metadata. UNPIVOT
  rejects statically known input columns whose declared types differ.
- **ROLLUP / CUBE / GROUPING SETS** — advanced groups expand into ordinary
  aggregate branches with GROUPING() replaced by branch-local tinyint bits.
  Source catalog annotations retain exact grouping/aggregate metadata through
  the compound result, including subtotal NULLs.
- **FOR JSON PATH / AUTO** — rendered queries return one SQL Server-named
  `nvarchar(max)` column. PATH supports dotted nesting and nested JSON
  subqueries; AUTO supports a single source or one root/child join level.
- **Scalar JSON** — a recursive source-spanned parser backs one-argument
  ISJSON, JSON_VALUE and JSON_QUERY. Scalar values remain nvarchar lexical
  text, strings decode escapes, object/array scalar requests become NULL in
  lax mode, and JSON_QUERY preserves the selected fragment's whitespace.
  Strict/malformed/oversize failures retain SQL Server JSON error numbers and
  both extraction functions expose `nvarchar(4000)` metadata.
- **IF/ELSE, WHILE, BEGIN…END, BREAK, CONTINUE, RETURN** — interpreted with
  proper signal propagation. Cooperative execution checks cancellation before
  statements and on every loop iteration, so unbounded interpreted loops do
  not monopolize the event loop.
- **Transactions** — nested BEGIN TRAN counts `@@TRANCOUNT`; only the
  outermost pair touches SQLite. ROLLBACK unwinds everything; SAVE TRAN
  maps to savepoints; `ROLLBACK TRAN name` targets a savepoint first. Attention
  does not implicitly roll back an explicit user transaction: statements that
  completed before cancellation remain in that transaction for the client to
  commit or roll back.
- **Bulk load** — `INSERT BULK` setup batches resolve one-, two-, or three-part
  targets and validate every selected column before packet data is accepted.
  Rows convert against catalog TYPE_INFO, enforce integer/decimal and declared
  string/binary widths, apply defaults unless KEEP_NULLS is present, and use
  cached insert statements inside a savepoint. Empty loads commit with count
  zero; decode, conversion, constraint, disconnect, and cancellation failures
  roll back the whole request. Omitted identity columns allocate from the same
  database-owned counter as ordinary INSERT; KEEPIDENTITY accepts explicit
  values and reseeds directionally. FIRE_TRIGGERS routes rows through
  interpreted INSERT execution. Failed and canceled loads keep consumed
  identity gaps while rolling back their rows.
- **Statement errors** — mapped constraint/conversion/arithmetic failures,
  RAISERROR below severity 20, and cursor/sequence runtime errors continue at
  the next statement while preserving ordered rows/counts/errors. Syntax,
  compile/name-resolution, THROW, severity 20+, and unsupported errors abort.
  XACT_ABORT ON rolls back and aborts qualifying runtime errors; RAISERROR
  ignores it. TRY/CATCH remains the inner interception boundary.
  Integer CAST/CONVERT truncates finite numeric inputs toward zero, maps empty
  character input to zero, and remains strict for invalid text (245) and range
  overflow (8115); TRY variants return NULL only for those failures. Explicit
  tinyint/smallint/int/bigint projections retain their declared TDS widths.
- **Checked arithmetic** — integer `+ - * / %` preserves NULL and integer-
  division semantics while raising 8134 for zero divisors and 8115 for inferred
  int/bigint overflow. SUM checks its int/bigint accumulator width; integer AVG
  uses the same checked sum, ignores NULLs, and truncates toward zero for
  ordinary, DISTINCT, windowed, PIVOT, and grouping-set aggregates. COUNT_BIG
  and AVG(bigint) retain eight-byte result metadata even for small or empty
  results. With both ARITHABORT and ANSI_WARNINGS OFF failures return NULL;
  otherwise they follow TRY/CATCH, continuation, and XACT_ABORT rules.
- **Implicit conversion** — declared column, variable, procedure, and RPC
  parameter types participate in T-SQL precedence. The same strict conversion
  path is applied to predicates, CASE/IN/BETWEEN, set operations, VALUES, and
  INSERT/UPDATE/MERGE assignments; conversion failures retain 245/241/8114/
  8169/8115 and incompatible operands raise 206/402 before SQLite affinity can
  change the comparison.
- **Date/time validation** — ordinary temporal casts and declared storage use
  proleptic civil-calendar validation instead of SQLite normalization. Invalid
  CAST/default/variable/RPC/DML values raise 241, TRY_CAST/TRY_CONVERT return
  NULL, and years 0001-9999 remain valid. DATEFROMPARTS and
  DATETIMEFROMPARTS propagate any NULL component, validate all ranges with 289,
  and expose native date/datetime result metadata.
- **IDENTITY** — each database owns exact bigint-backed state hydrated from
  `sys.identity_columns`. INSERT, MERGE, table variables, and bulk load honor
  signed seed/increment definitions independently of SQLite rowid. Allocation
  is shared across sessions, survives restart, and is not rolled back after a
  failed statement or transaction. Explicit values require session-scoped
  `SET IDENTITY_INSERT`, one table at a time; `@@IDENTITY`,
  `SCOPE_IDENTITY()`, `IDENT_CURRENT`, trigger/procedure scopes, bounds, and
  directional reseeding follow SQL Server behavior.
- **DDL** — executes the transpiled SQLite and updates the catalog in the
  same step. DELETE retains identity state; TRUNCATE transactionally resets
  the next value to the declared seed. ALTER TABLE ALTER COLUMN validates
  SQL Server dependency rules, converts stored values, and atomically rebuilds
  the SQLite table under a savepoint while preserving indexes, triggers,
  views, modules, catalog ids, defaults, constraints, and identity state.
- **Unique keys** — constraints and explicit unique indexes treat NULL as a
  comparable component of the complete key tuple. Supplemental/expression
  indexes apply the declared or default Unicode/padding collation key and
  preserve filtered predicates across INSERT,
  UPDATE, MERGE, triggers, and bulk load; failures retain statement atomicity
  and map to 2627 for constraints or 2601 for named indexes.
- **Default text comparisons** — `SQL_Latin1_General_CP1_CI_AS` is the
  canonical fallback for literals and default-collated columns. The same
  Unicode case-insensitive/accent-sensitive, U+0020-trimmed key drives scalar
  comparisons, joins, grouping, distinctness, set operators, ordering, and
  index lookup while original text remains available for result rows. Text
  foreign keys use durable SQLite triggers for padded child matching and
  NO ACTION/CASCADE/SET NULL/SET DEFAULT parent operations; DML target filters
  receive the same catalog collation metadata as SELECT sources.
- **Databases** — CREATE/DROP DATABASE owns an independent in-memory store or
  deterministic sibling file; ALTER DATABASE supports MODIFY NAME and
  READ_ONLY/READ_WRITE. USE switches the session's primary handle. Three-part
  names query attached stores, and three-part procedure calls execute in the
  procedure's database. Catalogs, modules, sequences, rowversion, and settings
  are database-scoped; `sys.databases` remains server-wide and mirrored.
- **SELECT INTO** — derives the target schema before row execution, preserving
  expression names, SQL types/widths, nullability, collation, and eligible
  direct-source identity seed/increment. The typed target is registered before
  insertion, so an out-of-transaction row failure leaves the documented empty
  table while an explicit rollback removes both schema and rows.
- **VALUES table sources** — shape/name validation preserves errors 8155,
  8156, 8158, 8159 and 10709 before execution. Resolved variables and each
  column's SQL-precedence common type/nullability feed coercion and exact TDS
  metadata across FROM, joins/APPLY, nested queries, and MERGE.
- **OUTPUT** — INSERT/DELETE (and inserted-only UPDATE) run the
  transpiled `RETURNING` and emit the rows as a result set. UPDATE
  reading `deleted.` values snapshots the affected rows into a temp
  table first, updates by rowid, then selects the OUTPUT items from the
  post-update table aliased `inserted` joined to the snapshot aliased
  `deleted` (`inserted.*` / `deleted.*` expand to the target's columns).
  `OUTPUT … INTO` re-inserts the rows into the target table and emits
  only the affected-row count, as MSSQL does.
- **MERGE** — decomposed, not rendered: preflight rejects duplicate actions
  (10714) and unreachable conditional arms (5324) before snapshot construction,
  so invalid statements cannot mutate the target. A snapshot temp table computed
  against the pre-merge state (source LEFT JOIN target, or FULL JOIN via
  a never-null source marker when NOT MATCHED BY SOURCE arms exist)
  stores each row's chosen arm and pre-evaluated SET / INSERT values;
  per-arm DELETE → UPDATE → INSERT statements read only the snapshot,
  inside an implicit transaction when none is open. A target row matched
  by more than one source row raises 8672 before any mutation;
  `@@ROWCOUNT` totals all actions. OUTPUT on MERGE assembles a UNION ALL
  of one SELECT per arm: `deleted` reads the pre-merge image captured in
  the snapshot, `inserted` reads the post-merge table rows (insert-arm
  rowids are recorded via `RETURNING` into a second temp table), and
  `$action` folds to each arm's literal action word. Items may reference
  only the pseudo-tables and `$action` — source columns are rejected.
- **EXEC sp_executesql** — full support from T-SQL and (via `executeSql`)
  from RPC. User procedures registered by CREATE PROCEDURE execute
  interpreted; unknown procedures report error 2812.
- **System procedures** — `sp_help`, `sp_helptext`, `sp_columns`, `sp_tables`,
  `sp_who`, `sp_helpdb`, `sp_spaceused`, and `sp_rename` dispatch before the
  user-procedure registry through both EXEC and RPC. Metadata procedures expose
  explicitly typed SQL Server/ODBC result schemas. Renames of tables/views,
  modules/sequences, columns, and user indexes update SQLite and the catalog
  atomically; dependent SQL text is not rewritten.
- **User functions** — CREATE/ALTER/DROP persists scalar (`FN`) and inline
  table-valued (`IF`) definitions in `sys.objects`/`sys.sql_modules` and
  reloads them on server startup. Scalar callbacks enter isolated parameter
  and local-variable scopes with defaults, recursive calls, a 32-level limit,
  declared return metadata, and side-effect validation. Inline TVFs substitute
  call arguments into their SELECT AST and render as derived sources; simple
  correlated APPLY calls lower to equality joins with CROSS/OUTER semantics.
- **DML triggers** — CREATE/ALTER/DROP persists `TR` definitions and reloads
  them on startup. AFTER and INSTEAD OF INSERT/UPDATE/DELETE bodies run once
  per statement through the interpreter with complete, read-only, multi-row
  `inserted` and `deleted` temp rowsets. Generated savepoints make the base DML
  and nested trigger effects atomic; unhandled trigger errors roll back an
  enclosing transaction. Direct recursion is suppressed, nesting caps at 32,
  and trigger-body affected counts precede the originating count unless the
  trigger uses SET NOCOUNT ON. OUTPUT,
  UPDATE FROM, and MERGE-trigger firing remain unsupported.
- **NOCOUNT** — every row/count item captures whether its statement completed
  under SET NOCOUNT ON. Cardinality stays intact for `@@ROWCOUNT`; the TDS
  layer uses the flag only to suppress the DONE-family count. Nested procedure,
  trigger, and dynamic-SQL option changes are restored on scope exit.
- **Cursors** — named DECLARE/OPEN/FETCH/CLOSE/DEALLOCATE cursors materialize
  SELECT rows and metadata at OPEN. NEXT/PRIOR/FIRST/LAST/ABSOLUTE/RELATIVE
  fetches return one row or assign INTO variables and update connection-global
  `@@FETCH_STATUS`. LOCAL cursors clean up with their batch/procedure/trigger;
  GLOBAL cursors persist in the session. All accepted cursor types currently
  use read-only static snapshots; cursor variables and positioned writes are
  not implemented.
- **Sequences** — CREATE/ALTER/DROP persists `SO` objects and NEXT VALUE FOR
  advances a database-wide BigInt counter shared atomically by every session.
  Signed increments, bounds, exhaustion, cycling, restart, cache metadata, and
  `sys.sequences` are supported. Dirty allocation state flushes after statements
  and after COMMIT/ROLLBACK, so consumed values survive rollback and restart.
- **Rowversion** — ROWVERSION and TIMESTAMP columns share one persistent
  unsigned counter per server database. INSERT and every affected UPDATE row
  receive a new big-endian binary(8), including no-op updates and indirect
  MERGE writes; explicit assignments are restricted to INSERT DEFAULT.
  `@@DBTS` reads the last value, rollback leaves gaps, and state is shared by
  tables, table variables, and sessions and survives restart.
- **Opaque special types** — target-column DML packs sql_variant base metadata,
  keeps untyped XML as Unicode text, and requires native serialized bytes for
  hierarchyid/geometry/geography. Catalog-derived results use Variant, XML,
  and UDT TDS metadata, so tedious receives primitive/XML/Buffer values without
  a text/binary fallback. Tedious 18.x cannot generate these parameter types;
  those client-side attempts fail with its explicit `not implemented` error.

## Column metadata

Result columns get TDS `TYPE_INFO` three ways: scalar projection descriptors and
table-valued-function, PIVOT/UNPIVOT, advanced-grouping, and FOR JSON renderings
provide declared hints before execution; `StatementSync.columns()`
table/column origins resolve through the catalog or active table-variable
definitions (exact declared types and nullability). Computed definitions have
their type inferred before DDL and catalog
registration, so VIRTUAL/STORED values retain declared metadata even for empty
results and after restart. Direct writes and nondeterministic definitions map
to SQL Server errors 271 and 4936.
The scalar descriptor covers literals, casts, operators, CASE/COALESCE/ISNULL,
aggregates/window functions, and supported built-ins, retaining exact widths,
precision/scale, collation, nullability, and special TDS families even for empty
results. Typed RPC parameters retain their declared descriptor through direct
SELECTs. Mixed scalar-UDF projections merge declared return types with ordinary
expression descriptors instead of reverting the whole result to value inference.
Client-facing statements enable node:sqlite positional rows, pairing each
value with `StatementSync.columns()` by index. Duplicate aliases and repeated
names from `SELECT *` joins therefore retain every value and origin type;
engine consumers still receive the existing `Rows.rows` array shape.

## UDFs

`registerFunctions` defines the `mssqlite_*` functions:
`add` (dynamic +), checked integer and exact scaled-decimal arithmetic,
decimal cast/comparison/order and SUM/AVG/MIN/MAX, `newid`, `rand`, `substring`, `left`, `right`,
`replicate`, `quotename`, `reverse`,
`stuff`, `charindex`, `patindex` (LIKE-pattern search), collation-aware LIKE
with bracket classes/ranges/ESCAPE and error 506 validation, `translate`,
character cast/storage coercion, Windows-1252 `ascii` / `char`,
UTF-16-unit `len` / `unicode` / `nchar` and boundary transforms,
type-aware `datalength`,
`round` (negative digits, truncate flag), `isnumeric`,
`isdate`, `name`, `dateadd`/`datediff`/`datepart`/`datename`/`eomonth`
(civil-calendar math with MSSQL boundary semantics, including offset-preserving
datetimeoffset arithmetic, UTC-normalized differences, and TZOFFSET), and session-scoped
`db_name`, `db_id`, `scope_identity`, `suser_sname`, `user_name`,
`host_name`, `app_name`, `serverproperty`.
