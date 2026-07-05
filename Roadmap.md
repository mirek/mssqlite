# Roadmap — toward full MSSQL support

Gap analysis of mssqlite against real SQL Server, grounded in the current
codebase. Phases are ordered by how often real applications and tools hit
the feature, weighted by implementation cost. Each item names the layers
it touches (`tsql` parse → `transpile` → `catalog` → `engine` → `tds`/`server`).

Status legend: ☐ missing · ◐ partial · ☑ done.

## Phase 1 — error handling and procedures (highest impact)

Real applications assume these everywhere; ORMs and migration tools
(EF Core, Flyway, Liquibase) generate them.

- ☑ **TRY/CATCH** — `BEGIN TRY … END TRY BEGIN CATCH … END CATCH`;
  catchable errors (severity 11–19) divert to the CATCH block instead of
  aborting the batch. Layers: tsql, engine.
- ☑ **ERROR_\* functions** — `ERROR_NUMBER/MESSAGE/SEVERITY/STATE/LINE/
  PROCEDURE()` reading the session's caught-error slot; NULL outside
  CATCH. Layers: transpile (function map), engine (session state, UDFs).
- ☑ **THROW rethrow** — bare `THROW` inside CATCH re-raises the original
  error. Layers: engine.
- ☑ **RAISERROR** — `RAISERROR(msg | msg_id | @var, severity, state
  [, args…]) [WITH NOWAIT]` with `%s`/`%d` printf substitution; severity
  ≤ 10 is an informational message, not an error. Layers: tsql, engine.
- ☑ **XACT_STATE() / SET XACT_ABORT** — 1/0/−1 transaction state,
  doomed-transaction semantics under XACT_ABORT. Layers: transpile,
  engine.
- ☑ **Stored procedures** — `CREATE/ALTER/DROP PROCEDURE`, `EXEC` with
  positional/named/default/OUTPUT parameters, `RETURN n` status,
  `EXEC @rc = proc`, nested procs with `@@NESTLEVEL`, definitions in
  `sys.procedures` + `sys.sql_modules` (`OBJECT_DEFINITION`,
  `sp_helptext`). Layers: tsql, catalog, engine, server (RETURNVALUE /
  ReturnStatus already wired for RPC).

## Phase 2 — query and DML surface

- ☑ **TOP fidelity** — `TOP n PERCENT`, `TOP … WITH TIES`,
  `UPDATE/DELETE TOP (n)`. Parser holds most of the AST already;
  transpile rejects them today. Layers: tsql (WITH TIES), transpile.
- ☑ **DELETE alias double-FROM** — `DELETE a FROM t AS a JOIN …`
  (UPDATE-with-FROM already works). Layers: transpile.
- ☐ **OUTPUT clause** — `INSERT … OUTPUT inserted.*`,
  `UPDATE/DELETE … OUTPUT deleted.*` (`RETURNING` exists in SQLite
  ≥ 3.35, node ≥ 22 ships it). Layers: tsql, transpile, engine.
- ☐ **MERGE** — WHEN MATCHED / NOT MATCHED [BY SOURCE] arms; decompose
  into UPDATE/INSERT/DELETE inside one implicit transaction, or SQLite
  UPSERT for the common two-arm case. Layers: tsql, transpile, engine.
- ☐ **Table variables** — `DECLARE @t TABLE (…)` as session-scoped temp
  tables with generated names; INSERT/SELECT against them. Layers: tsql,
  transpile (name mapping), engine.
- ☐ **Table-valued functions in FROM** — `STRING_SPLIT`, `OPENJSON`
  (SQLite `json_each` maps well), `GENERATE_SERIES`. Layers: tsql,
  transpile.
- ☐ **CROSS/OUTER APPLY** — lateral joins; SQLite has no LATERAL, but
  correlated flattening covers the common TVF/TOP-1 patterns. Layers:
  tsql, transpile.
- ☐ **PIVOT / UNPIVOT** — rewrite to conditional aggregation / UNION ALL.
  Layers: tsql, transpile.
- ☐ **GROUP BY ROLLUP/CUBE/GROUPING SETS, GROUPING()** — expand to
  UNION ALL of grouping sets. Layers: tsql, transpile.
- ☐ **FOR JSON PATH/AUTO** — SQLite `json_object`/`json_group_array`
  rendering. `FOR XML` later (niche outside legacy apps). Layers: tsql,
  transpile.
- ☐ **Scalar user functions** — `CREATE FUNCTION … RETURNS scalar` —
  interpret body like procedures; inline table-valued functions as
  parameterized views. Layers: tsql, catalog, engine.
- ☐ **Triggers** — `CREATE TRIGGER … AFTER/INSTEAD OF` mapping to SQLite
  triggers where the body transpiles; else interpret. Layers: tsql,
  transpile, catalog, engine.
- ☐ **Cursors** — DECLARE/OPEN/FETCH/CLOSE/DEALLOCATE, `@@FETCH_STATUS`;
  materialize the result set and iterate engine-side. Layers: tsql,
  engine.
- ☐ **Sequences** — `CREATE SEQUENCE`, `NEXT VALUE FOR` on a counters
  table. Layers: tsql, catalog, transpile.

## Phase 3 — semantics and type fidelity

- ☐ **Exact DECIMAL/NUMERIC arithmetic** — results currently ride SQLite
  float affinity; route decimal ops through a scaled-integer or string
  UDF path and emit exact TDS decimals (`tds/decimal.ts` already
  encodes). Layers: transpile, engine, tds.
- ☐ **SET NOCOUNT honored** — suppress DONE_IN_PROC counts (today the
  option is stored but ignored). Layers: engine, server.
- ☐ **Computed columns** — parser accepts, transpile rejects; SQLite
  generated columns cover PERSISTED and virtual. Populate
  `sys.computed_columns`. Layers: transpile, catalog.
- ☐ **Collation surface** — per-column `COLLATE` beyond NOCASE
  (accent-sensitivity, binary collations via custom SQLite collations).
  Layers: transpile, engine.
- ☐ **datetimeoffset semantics** — preserve offset (stored today as
  text; comparisons/DATEPART should honor the offset). Layers: engine
  (date functions), tds.
- ☐ **rowversion/timestamp** — auto-incrementing binary(8) via triggers.
  Layers: transpile, catalog, engine.
- ☐ **sql_variant, hierarchyid, geography/geometry, XML type** — accept
  and round-trip as opaque values first; behavior later (niche).
- ☐ **Duplicate column names in one result set** — rows currently read
  as objects and collapse; needs node:sqlite `returnArrays` (landed in
  newer node) or a rename-and-map pass. Layers: engine.

## Phase 4 — protocol and operational surface

- ☐ **TLS** — prelogin ENCRYPT negotiation + TLS wrap of the stream;
  modern drivers (tedious ≥ 16, go-mssqldb, JDBC) default to encrypted
  connections, so this gates real-tool adoption. Layers: tds, server.
- ☐ **System stored procedures** — `sp_help`, `sp_columns`, `sp_tables`,
  `sp_who`, `sp_helpdb`, `sp_rename`, `sp_spaceused` — SSMS/Azure Data
  Studio and ODBC catalog calls use them. Layers: engine (interpreted,
  reading the catalog).
- ☐ **More catalog** — `INFORMATION_SCHEMA.ROUTINES/VIEWS/
  TABLE_CONSTRAINTS/KEY_COLUMN_USAGE/REFERENTIAL_CONSTRAINTS`,
  `sys.sql_modules`, `sys.default_constraints` details, minimal
  `sys.dm_exec_sessions`/`dm_exec_requests`. Layers: catalog.
- ☐ **Multiple databases** — `CREATE DATABASE` / real `USE` via SQLite
  `ATTACH`; per-database catalogs. Layers: engine, catalog, transpile
  (name flattening becomes schema-qualified). Large; design first.
- ☐ **Authentication** — optional real password check for `sa`/users
  (today any credentials pass); SSPI/NTLM/FedAuth negotiation is out of
  scope for v1. Layers: server.
- ☐ **Bulk load** — TDS BulkLoadBCP (type 7) for `bcp` and
  `SqlBulkCopy`. Layers: tds, server, engine.
- ☐ **MARS** — multiple active result sets; low priority (drivers
  default off). Layers: tds, server.
- ☐ **Attention/cancel fidelity** — cancel mid-execution (long WHILE
  loops should abort between statements). Layers: engine, server.

## Non-goals (for now)

Replication, Service Broker, CLR integration, full-text search, linked
servers, query hints with real effect (parsed and ignored), Resource
Governor, columnstore, In-Memory OLTP, Agent jobs.

## Testing strategy per phase

Every feature lands with the three-level pattern already in the repo:
parser unit tests (`tsql`), executable-SQL tests against real SQLite
(`transpile`/`engine`), and e2e through a real `tedious` connection
(`server`). Ground truth for semantics is real SQL Server behavior —
document divergences in the relevant `.agents/skills` file as they are
discovered.
