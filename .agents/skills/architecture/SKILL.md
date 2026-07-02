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
  SQLite; SAVE TRAN → savepoints.
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

## Known limitations (v1)

- No TLS — prelogin answers `ENCRYPT_NOT_SUP`; clients must connect with
  `encrypt: false`. No MARS, no SSPI/FedAuth (any credentials accepted).
- No CREATE PROCEDURE/FUNCTION/TRIGGER, MERGE, PIVOT, APPLY, cursors,
  TRY/CATCH, TOP PERCENT, UPDATE/DELETE TOP, DELETE double-FROM.
- Duplicate column names in one result set collapse (rows read as
  objects; `returnArrays` lands in newer node:sqlite).
- `USE db` switches the session label only — one database per server.
- Decimal results ride SQLite NUMERIC (float) affinity — exact decimal
  wire encoding exists in `tds/decimal.ts` but result-set decimals lose
  exactness beyond doubles.
- `@@ROWCOUNT` after SELECT reflects rows returned; unsupported globals
  raise error 137.
