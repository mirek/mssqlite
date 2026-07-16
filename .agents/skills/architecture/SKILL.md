---
name: architecture
description: "mssqlite system architecture: package dependency graph, request lifecycle from TDS packet to SQLite and back, key design decisions (name flattening, NOCASE collation, parameter passthrough, UDF strategy, session model, metadata inference) and current limitations. Use when deciding where a change belongs, extending T-SQL/protocol coverage, or debugging cross-layer behavior."
---

# mssqlite Architecture

MSSQL compatible, SQLite backed, SQL Server. Two independent towers meet in
the engine:

```
        wire                          language
  @mssqlite/bytes               @mssqlite/tsql (lex/parse → AST)
        │                             │
  @mssqlite/tds                 @mssqlite/transpile (AST → SQLite SQL)
        │                             │
        │                       @mssqlite/catalog (sys.* emulation)
        │                             │
        └──── @mssqlite/server ── @mssqlite/engine ── node:sqlite
```

## Request lifecycle

1. **Socket bytes → messages** — `Tds.Message.push` reassembles packets
   (pure incremental state) into `{ type, payload }` messages.
2. **Dispatch by packet type** (`server/connection.ts`) — prelogin,
   login7, SQL batch, RPC, transaction manager, attention.
3. **SQL batch** — `engine.executeBatch(session, sql)`:
   - `tsql.parse` → `Ast.Statement[]`
   - per statement: directly renderable (SELECT/DML/DDL) → transpile →
     prepared SQLite statement with variables bound as native `@x`
     parameters; interpreted (DECLARE/SET/IF/WHILE/transactions/EXEC) →
     engine logic, scalar expressions evaluated via `SELECT (expr)`.
   - DDL additionally updates the catalog (`catalog.createTable` …).
4. **Results → tokens** — engine items (`rows` with TDS TypeInfo columns,
   `count`, `message`) render through `Tds.Token.*` encoders
   (`server/respond.ts`), split into packets, written back.
5. **RPC** — tedious sends parameterized queries as `sp_executesql`;
   parameters decode to JS values (`Tds.Value.decode`) and bind as scoped
   variables (`engine.executeSql`), OUTPUT values return as RETURNVALUE
   tokens.

## Key decisions

- **Name flattening** (`transpile/quote.ts`) — database qualifiers and
  `dbo` drop (`master.dbo.users` → `"users"`); `sys` /
  `INFORMATION_SCHEMA` become flat lowercase names (`"sys.tables"`) that
  are *real SQLite tables/views* created by the catalog — catalog queries
  need no interception; other schemas flatten (`"app.users"`); `#temp` →
  SQLite `temp` schema.
- **Case-insensitivity** — char/text columns get `COLLATE NOCASE`,
  approximating `SQL_Latin1_General_CP1_CI_AS`. LIKE is already
  ASCII-case-insensitive in SQLite.
- **Variables are SQLite parameters** — `@x` passes through (SQLite
  supports `@`-parameters natively); each rendered statement carries its
  used-variable list so the engine binds exactly those. Globals map to
  `@__rowcount`-style parameters bound from session state.
- **Table variables are scoped temp tables** — `DECLARE @t TABLE (...)`
  allocates a collision-free `temp` table keyed by the active batch or
  procedure scope. The engine resolves object-position `@t` references
  before transpilation, keeps declared column metadata beside the backing
  name, and drops all backing tables on scope exit. Procedure calls and
  `sp_executesql` swap in isolated table-variable maps, so callers' table
  variables are not visible to nested work.
- **Built-in TVFs render as derived sources** — FROM-source function ASTs
  dispatch `STRING_SPLIT` to a JSON-array scalar adapter plus `json_each`,
  `OPENJSON` to JSON1 with SQL Server key/value/type or explicit WITH
  projections, and `GENERATE_SERIES` to a recursive CTE (the Node SQLite
  build has no series module). The transpiler attaches output type hints to
  simple TVF SELECTs so the engine can emit exact metadata before stepping,
  including for empty inputs.
- **APPLY has shape-specific lowering** — correlated two-argument
  STRING_SPLIT lowers to SQLite's implicitly lateral `json_each` source;
  simple correlated TOP (1) derived queries move equality correlation keys
  into a join and rank right rows with `ROW_NUMBER() OVER (PARTITION BY ...
  ORDER BY ...)`. CROSS APPLY uses INNER JOIN, OUTER APPLY uses LEFT JOIN.
  Complex correlation and star projection over ranked helper columns are
  rejected explicitly.
- **PIVOT/UNPIVOT use source-schema-aware lowering** — the engine annotates
  table leaves with catalog or table-variable column metadata. PIVOT emits
  one conditional aggregate per listed value and groups all remaining input
  columns. UNPIVOT materializes the source once, expands it with `UNION ALL`,
  and filters NULL values. The metadata annotations also provide stable TDS
  types for generated columns; incompatible known UNPIVOT types are rejected.
- **Advanced grouping expands before SQLite** — ROLLUP prefixes, CUBE's
  lattice, and explicit GROUPING SETS become ordered UNION ALL branches;
  duplicates are intentionally preserved. Each branch substitutes NULL for
  omitted grouping expressions and folds GROUPING(expr) to a tinyint 0/1.
  Simple sources are captured in one MATERIALIZED CTE (also stabilizing
  volatile derived expressions); joins currently repeat their source per
  branch because one CTE alias cannot preserve every original qualifier.
- **FOR JSON is an outer aggregation rewrite** — a synthetic inner SELECT
  evaluates and orders projected expressions once; PATH builds alias trees
  with JSON objects/patches, while AUTO classifies selected columns by source
  alias and groups one child array beneath each root row. JSON_QUERY and
  nested FOR JSON expressions are explicitly re-tagged as SQLite JSON after
  crossing the inner-query boundary. The output always has SQL Server's
  magic column name and nvarchar(max) hint.
- **User functions share persisted module infrastructure** — sys.objects uses
  `FN` for scalar and `IF` for inline TVFs; definitions live beside procedures
  in sys.sql_modules and reparse at server startup. Scalar names dispatch to
  varargs node:sqlite callbacks that enter an isolated engine variable scope;
  inline TVFs instead substitute argument ASTs into the stored SELECT before
  ordinary table-source resolution. Simple correlated inline sources reuse
  APPLY's extracted equality-key join lowering.
- **DML triggers are statement-level engine work** — persisted `TR` modules
  reparse into `server.triggers` at startup. A triggerable INSERT/UPDATE/DELETE
  runs inside a generated savepoint; `RETURNING` plus a pre-update snapshot
  produce complete multi-row images, which are copied to uniquely named temp
  tables and resolved as read-only `inserted` / `deleted` sources while the
  ordinary AST interpreter runs the body. This deliberately does not use
  SQLite's row-level trigger subsystem. INSTEAD OF triggers receive intended
  images and replace the base operation; direct self-recursion is suppressed,
  other nested triggers share the 32-level module limit, and an unhandled
  trigger error rolls back an enclosing user transaction. Trigger-body count
  items are suppressed and the originating statement restores `@@ROWCOUNT`.
- **Cursors are session-owned materialized results** — DECLARE stores a SELECT
  AST and lifecycle state in `session.cursors`; OPEN resolves the active scope,
  executes the query once, and retains rows plus TDS column metadata. FETCH
  changes a bounded position, copies into variables or emits a one-row result,
  and sets connection-global `@@FETCH_STATUS`. LOCAL cursors declared in a
  batch, procedure, or trigger are removed on that scope's normal or exceptional
  exit; GLOBAL cursors survive batches until DEALLOCATE or session disposal.
- **Sequence allocation is server-global and rollback-independent** — `SO`
  definitions and counters persist in `sys.sequence_state` and surface through
  `sys.sequences`; server startup hydrates a BigInt registry keyed by schema and
  name. The nondeterministic NEXT VALUE UDF advances that shared registry
  synchronously, making sessions atomic without re-entering SQLite. Dirty values
  flush after each completed autocommit statement; inside a user transaction
  they flush immediately after COMMIT or ROLLBACK, so rollback never reissues a
  consumed value. CREATE/ALTER/DROP remain ordinary transactional catalog DDL.
- **`+` dispatch** — static inference picks `+` / `||`; unknown operand
  types fall back to the `mssqlite_add` UDF (numbers add, strings concat).
- **UDF strategy** — anything without a clean SQLite rendering becomes an
  `mssqlite_*` function registered once per server (`engine/udf.ts`).
  Session-dependent UDFs (`db_name`, `scope_identity`, …) read
  `server.current`, set at batch entry — valid because execution is
  synchronous and single-threaded.
- **Catalog functions become subqueries** — `OBJECT_ID('t')` →
  `(SELECT object_id FROM "sys.objects" WHERE …)`; UDFs cannot re-enter
  the database connection.
- **IDENTITY = rowid alias** — `INTEGER PRIMARY KEY AUTOINCREMENT`
  (never-reused ids like MSSQL); TRUNCATE clears `sqlite_sequence`.
- **Session model** — one `DatabaseSync` per server, shared by sessions;
  SQLite serializes writes, one transaction at a time across sessions.
  Nested BEGIN TRAN counts `@@TRANCOUNT`; only the outermost pair touches
  SQLite; SAVE TRAN → savepoints. Under `SET XACT_ABORT ON` a caught
  error dooms the transaction (`XACT_STATE()` −1, COMMIT raises 3930).
- **Error handling** — TRY/CATCH is engine control flow: the try body's
  thrown `MssqlError` (severity ≤ 19) lands in a CATCH-scoped
  `session.caughtError` slot that `ERROR_NUMBER()`-family UDFs read;
  bare `THROW` rethrows it. RAISERROR severity ≤ 10 becomes a `message`
  item, higher throws.
- **Batch errors preserve statement boundaries** — parse/name-resolution and
  explicit THROW failures abort, while mapped constraint errors (515/547/2601/
  2627), conversion/arithmetic classes, RAISERROR below severity 20, and
  cursor/sequence runtime errors become ordered engine `error` items and the
  next statement executes. A `BatchError` still rejects the public call after
  execution but retains all prior rows/counts/errors for the TDS layer. Each
  successful statement resets `@@ERROR`; a failure sets it and zeroes
  `@@ROWCOUNT` before continuation. Qualifying errors under XACT_ABORT ON roll
  back the user transaction and abort; RAISERROR explicitly ignores XACT_ABORT.
  Integer CAST/CONVERT routes through a strict UDF so invalid text raises 245,
  overflow raises 8115, and TRY_CAST/TRY_CONVERT returns NULL instead of relying
  on SQLite's permissive conversion-to-zero behavior.
- **Stored procedures are interpreted AST** — `CREATE PROCEDURE` stores
  the parsed body in a server-wide registry (`server.procedures`, keyed
  `schema.name` lowercased) and persists the batch source in
  `sys.sql_modules` (reloaded and re-parsed on server start). EXEC
  swaps the session's variable-scope contents (the map reference is
  shared), binds positional/named/default/OUTPUT parameters, honors
  RETURN status and `@@NESTLEVEL` (cap 32). The RPC fallback renders
  `EXEC name @p = @p OUTPUT` over `executeSql` so driver `callProcedure`
  round-trips OUTPUT values and return status.
- **MERGE is decomposed, not rendered** (`engine/merge.ts`) — one
  snapshot temp table computed against the pre-merge state joins source
  to target (LEFT JOIN, or FULL JOIN through a never-null source marker
  column when NOT MATCHED BY SOURCE arms exist) and stores each row's
  chosen arm tag plus every pre-evaluated SET / INSERT value; per-arm
  DELETE → UPDATE → INSERT statements then read only the snapshot, inside
  an implicit transaction when none is open. A target row matched by more
  than one source row raises 8672 before any mutation. OUTPUT reuses the
  snapshot as the `deleted` image (the target's pre-merge columns are
  captured alongside the arm values), records insert-arm rowids via
  RETURNING into a second temp table for the `inserted` image, and emits
  a UNION ALL of one SELECT per arm with `$action` folded to a literal.
- **Column metadata** — `StatementSync.columns()` origins resolve through
  the catalog for exact declared types; computed columns infer from value
  shape (int32/int64/float/nvarchar(max)/varbinary(max)).
- **Date/time as TEXT** — MSSQL-format strings
  (`YYYY-MM-DD HH:MM:SS.fff…`); TDS codecs parse/format via proleptic
  civil-date math (no JS `Date` range limits); date UDFs implement MSSQL
  boundary-counting semantics.

## Extension points

- New built-in function → `transpile/functions.ts` handler (native
  rendering, rewrite, subquery) or new `mssqlite_*` UDF in
  `engine/udf.ts` — keep both sides in sync.
- New statement kind → AST type (`tsql/ast.ts`), grammar
  (`tsql/parse/statement.ts`), then either a transpile rendering or an
  engine interpretation (`engine/execute.ts` switch).
- New token/protocol feature → `tds/token/*`, wire it in
  `server/respond.ts` or `server/connection.ts`.

## Robustness invariants (enforced, regression-tested)

- **Decoders never hang or throw uncaught on hostile bytes.** `Message.push`
  rejects a packet whose length is below the header size (malformed framing →
  connection dropped, not an infinite loop); `AllHeaders.decode` rejects a
  zero-length inner header; `Value.decode` turns short/unknown-type reads into
  `Result` failures instead of exceptions. A deterministic fuzz sweep guards
  all top-level decoders (`packages/tds/src/robustness.test.ts`).
- **No silent wire corruption from oversized values.** A non-`max` value that
  would overflow its length prefix throws a clean error (mapped to an MSSQL
  error) rather than wrapping the prefix; column names are capped at 128 chars.
- **Canceled requests are honored.** A message whose EOM packet carries the
  IGNORE status bit (how tedious cancels mid-send) is discarded, not executed.
- **varchar/char/text use Windows-1252** (`@mssqlite/bytes` `Cp1252`), matching
  the advertised `SQL_Latin1_General_CP1` collation — `€`, em dash and smart
  quotes round-trip instead of corrupting as ISO-8859-1.

## Known limitations (v1)

See [TODO.md](../../../TODO.md) for the prioritized implementation briefs
toward broader SQL Server compatibility.

- No TLS — prelogin answers `ENCRYPT_NOT_SUP`; clients must connect with
  `encrypt: false`. No MARS, no SSPI/FedAuth (any credentials accepted).
- Cursor variables, positioned updates, and live KEYSET/DYNAMIC visibility are
  unsupported. Sequence DECIMAL/NUMERIC precision is capped at 18, cache options
  are metadata-only, same-row duplicate NEXT VALUE references are not coalesced,
  and an abnormal shutdown during an open user transaction can lose unflushed
  consumption state. Triggered DML does not yet support OUTPUT or
  UPDATE FROM, and MERGE does not yet fire DML triggers. MERGE OUTPUT may not
  reference source columns. Unlike SQL Server, table
  variable changes currently participate in the surrounding SQLite
  transaction and therefore roll back with it.
- Error classification currently covers mapped constraints, known conversion/
  arithmetic numbers, RAISERROR, cursor and sequence ranges; additional SQL
  Server statement-vs-batch cases will be added as their operations land.
  Division by zero still yields NULL (SQLite) instead of error 8134.
- Duplicate column names in one result set collapse (rows read as
  objects; `returnArrays` lands in newer node:sqlite).
- `USE db` switches the session label only — one database per server.
- Decimal results ride SQLite NUMERIC (float) affinity — exact decimal
  wire encoding exists in `tds/decimal.ts` but result-set decimals lose
  exactness beyond doubles.
- `@@ROWCOUNT` after SELECT reflects rows returned; unsupported globals
  raise error 137. `ERROR_LINE()` is always 1 (no statement positions in
  the AST).
