# @mssqlite/engine

T-SQL execution engine over `node:sqlite`. Parses batches with
[`@mssqlite/tsql`](../tsql), renders SQL with
[`@mssqlite/transpile`](../transpile), maintains the
[`@mssqlite/catalog`](../catalog), and interprets what SQLite can't run —
variables, control flow, transactions, procedures.

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
  `count`, `message`. Throws `MssqlError` with MSSQL error number, severity
  and state (208 invalid object, 2627 unique violation, 547 FK/CHECK,
  515 not null, 102 syntax, 137 undeclared variable, …).
- `executeSql(session, sql, parameters)` — `sp_executesql` semantics:
  parameters bind as scoped variables, OUTPUT values return.
- `evaluate(session, expression)` — scalar evaluation used for DECLARE
  initializers, SET, IF/WHILE conditions and PRINT.

## Interpretation

- **DECLARE / SET / SELECT @x = …** — variables live in the session,
  bound as native SQLite parameters. Assignment SELECTs return no result
  set and assign from the last row, as MSSQL does.
- **IF/ELSE, WHILE, BEGIN…END, BREAK, CONTINUE, RETURN** — interpreted with
  proper signal propagation.
- **Transactions** — nested BEGIN TRAN counts `@@TRANCOUNT`; only the
  outermost pair touches SQLite. ROLLBACK unwinds everything; SAVE TRAN
  maps to savepoints; `ROLLBACK TRAN name` targets a savepoint first.
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
  `@@ROWCOUNT` totals all actions. OUTPUT on MERGE is not yet supported.
- **EXEC sp_executesql** — full support from T-SQL and (via `executeSql`)
  from RPC. User procedures registered by CREATE PROCEDURE execute
  interpreted; unknown procedures report error 2812.

## Column metadata

Result columns get TDS `TYPE_INFO` two ways: `StatementSync.columns()`
table/column origins resolve through the catalog (exact declared types,
nullability); computed columns fall back to value-shape inference
(int32/int64/float/nvarchar(max)/varbinary(max)/bit).

## UDFs

`registerFunctions` defines the `mssqlite_*` functions:
`add` (dynamic +), `newid`, `rand`, `right`, `replicate`, `reverse`,
`stuff`, `charindex`, `patindex` (LIKE-pattern search), `translate`,
`datalength`, `round` (negative digits, truncate flag), `isnumeric`,
`isdate`, `name`, `dateadd`/`datediff`/`datepart`/`datename`/`eomonth`
(civil-calendar math with MSSQL boundary semantics), and session-scoped
`db_name`, `db_id`, `scope_identity`, `suser_sname`, `user_name`,
`host_name`, `app_name`, `serverproperty`.
