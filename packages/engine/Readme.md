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
  many sessions on a shared connection (SQLite serializes writes; one
  transaction at a time).
- `session(server)` — per-connection state: declared variables, SET
  options, `@@ROWCOUNT` / `@@IDENTITY` / `@@TRANCOUNT` / `@@ERROR`, spid.
- `executeBatch(session, sql)` — items: `rows` (with TDS column metadata),
  `count`, `message`, and ordered recoverable `error` entries. Throws
  `BatchError` after a mixed-error batch (retaining all produced items) or
  `MssqlError` for compile/batch-aborting failures, with MSSQL number, severity
  and state (208 invalid object, 2627 unique violation, 547 FK/CHECK,
  515 not null, 102 syntax, 137 undeclared variable, …).
- `executeSql(session, sql, parameters)` — `sp_executesql` semantics:
  parameters bind as scoped variables, OUTPUT values return.
- `evaluate(session, expression)` — scalar evaluation used for DECLARE
  initializers, SET, IF/WHILE conditions and PRINT.

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
  Small scalar adapters validate splitting/series arguments; SQLite
  `json_each` and a streaming recursive CTE produce the rows.
- **CROSS / OUTER APPLY** — supported for correlated two-argument
  STRING_SPLIT and simple correlated TOP (1) derived queries. CROSS removes
  empty right sides; OUTER retains the left row with NULL right columns.
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
- **IF/ELSE, WHILE, BEGIN…END, BREAK, CONTINUE, RETURN** — interpreted with
  proper signal propagation.
- **Transactions** — nested BEGIN TRAN counts `@@TRANCOUNT`; only the
  outermost pair touches SQLite. ROLLBACK unwinds everything; SAVE TRAN
  maps to savepoints; `ROLLBACK TRAN name` targets a savepoint first.
- **Statement errors** — mapped constraint/conversion/arithmetic failures,
  RAISERROR below severity 20, and cursor/sequence runtime errors continue at
  the next statement while preserving ordered rows/counts/errors. Syntax,
  compile/name-resolution, THROW, severity 20+, and unsupported errors abort.
  XACT_ABORT ON rolls back and aborts qualifying runtime errors; RAISERROR
  ignores it. TRY/CATCH remains the inner interception boundary.
  Integer CAST/CONVERT is strict (245 conversion, 8115 overflow), with TRY
  variants returning NULL.
- **Checked arithmetic** — integer `+ - * / %` preserves NULL and integer-
  division semantics while raising 8134 for zero divisors and 8115 for inferred
  int/bigint overflow. SUM checks int width, or bigint width when its argument
  is explicitly cast. With both ARITHABORT and ANSI_WARNINGS OFF failures return
  NULL; otherwise they follow TRY/CATCH, continuation, and XACT_ABORT rules.
- **DDL** — executes the transpiled SQLite and updates the catalog in the
  same step. TRUNCATE resets `sqlite_sequence` (identity restarts).
- **SELECT INTO** — `CREATE TABLE … AS SELECT` plus catalog registration.
- **OUTPUT** — INSERT/DELETE (and inserted-only UPDATE) run the
  transpiled `RETURNING` and emit the rows as a result set. UPDATE
  reading `deleted.` values snapshots the affected rows into a temp
  table first, updates by rowid, then selects the OUTPUT items from the
  post-update table aliased `inserted` joined to the snapshot aliased
  `deleted` (`inserted.*` / `deleted.*` expand to the target's columns).
  `OUTPUT … INTO` re-inserts the rows into the target table and emits
  only the affected-row count, as MSSQL does.
- **MERGE** — decomposed, not rendered: a snapshot temp table computed
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
  advances a server-wide BigInt counter shared atomically by every session.
  Signed increments, bounds, exhaustion, cycling, restart, cache metadata, and
  `sys.sequences` are supported. Dirty allocation state flushes after statements
  and after COMMIT/ROLLBACK, so consumed values survive rollback and restart.

## Column metadata

Result columns get TDS `TYPE_INFO` three ways: table-valued-function,
PIVOT/UNPIVOT, advanced-grouping, and FOR JSON renderings provide declared hints before
execution; `StatementSync.columns()`
table/column origins resolve through the catalog or active table-variable
definitions (exact declared types and nullability). Computed definitions have
their type inferred before DDL and catalog
registration, so VIRTUAL/STORED values retain declared metadata even for empty
results and after restart. Direct writes and nondeterministic definitions map
to SQL Server errors 271 and 4936.

## UDFs

`registerFunctions` defines the `mssqlite_*` functions:
`add` (dynamic +), checked integer and exact scaled-decimal arithmetic,
decimal cast/comparison/order and SUM/AVG/MIN/MAX, `newid`, `rand`, `right`, `replicate`, `reverse`,
`stuff`, `charindex`, `patindex` (LIKE-pattern search), `translate`,
`datalength`, `round` (negative digits, truncate flag), `isnumeric`,
`isdate`, `name`, `dateadd`/`datediff`/`datepart`/`datename`/`eomonth`
(civil-calendar math with MSSQL boundary semantics), and session-scoped
`db_name`, `db_id`, `scope_identity`, `suser_sname`, `user_name`,
`host_name`, `app_name`, `serverproperty`.
