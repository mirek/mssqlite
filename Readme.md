# mssqlite

MSSQL compatible, SQLite backed, SQL Server.

A TDS 7.4 server that speaks Microsoft SQL Server's wire protocol and
T-SQL, storing everything in SQLite via Node's built-in `node:sqlite` —
no native dependencies. Real MSSQL clients connect unmodified:

```sh
pnpm install
pnpm start                     # mssqlite listening on port 1433, database :memory:
node packages/server/src/bin.ts data.db 1433
```

```ts
import { Connection, Request } from 'tedious'

const connection = new Connection({
  server: '127.0.0.1',
  authentication: { type: 'default', options: { userName: 'sa', password: '...' } },
  options: { port: 1433, encrypt: false, trustServerCertificate: true }
})
```

The CLI is plaintext with authentication disabled for local development.
Embedded use requires an explicit insecure or scrypt-backed authentication
policy; password mode also requires TLS. See the
[`@mssqlite/server` guide](packages/server) for certificate configuration.

## Packages

Bottom-up, each layer fully tested and documented before the next:

| Package | What |
|---|---|
| [`@mssqlite/bytes`](packages/bytes) | Binary cursor, decode combinators, encode builders (little-endian, UCS-2) |
| [`@mssqlite/tds`](packages/tds) | TDS 7.4 wire codecs — packets, prelogin/login7, tokens, TYPE_INFO, values |
| [`@mssqlite/tsql`](packages/tsql) | T-SQL lexer and parser (token combinators) → typed AST |
| [`@mssqlite/transpile`](packages/transpile) | T-SQL AST → SQLite SQL, function mapping, parameter tracking |
| [`@mssqlite/catalog`](packages/catalog) | `sys.*` and `INFORMATION_SCHEMA` emulation, DDL maintenance |
| [`@mssqlite/engine`](packages/engine) | Execution engine — sessions, variables, control flow, transactions, UDFs |
| [`@mssqlite/server`](packages/server) | TCP TDS server — e2e tested with the `tedious` client |

Everything is written in a functional, composable style after the
[`@prelude/*`](https://www.npmjs.com/org/prelude) packages — immutable
readers, results as values, file-per-function modules, namespace re-exports.

## What works

SELECT (joins, CTEs, set operations, TOP with PERCENT / WITH TIES,
OFFSET-FETCH, window functions), INSERT/UPDATE/DELETE with `@p` parameters
over RPC (including UPDATE/DELETE TOP, DELETE ... FROM with joins, and the
OUTPUT clause with `inserted.*` / `deleted.*` and OUTPUT ... INTO),
MERGE (all WHEN arms with AND conditions, OUTPUT with `$action`),
stored procedures (CREATE/ALTER/DROP PROCEDURE, EXEC with named/default/
OUTPUT parameters, RETURN status, `sys.sql_modules` persistence),
catalog and administration procedures (`sp_help`, `sp_helptext`, `sp_columns`,
`sp_tables`, `sp_who`, `sp_helpdb`, `sp_spaceused`, and atomic `sp_rename`),
statement-level AFTER and INSTEAD OF DML triggers with persisted definitions
and multi-row `inserted` / `deleted` transition tables,
session cursors with LOCAL/GLOBAL lifetime, scroll fetches, INTO assignment,
and `@@FETCH_STATUS`,
cataloged sequences with atomic NEXT VALUE FOR allocation, bounds/cycling,
restart persistence, and rollback-independent consumption,
multiple persistent databases with CREATE/ALTER/DROP DATABASE, real USE,
isolated catalogs and three-part cross-database queries/procedure calls,
database-wide ROWVERSION/TIMESTAMP generation with `@@DBTS`, automatic
insert/update stamping, rollback gaps, and binary(8) wire metadata,
TRY/CATCH with THROW/RAISERROR and `ERROR_*()` / `XACT_STATE()`,
CREATE/ALTER/DROP TABLE with IDENTITY, constraints and foreign keys,
indexes and views, DECLARE/SET variables, IF/WHILE control flow, nested
transactions and savepoints, `sys.tables` / `sys.columns` /
expanded `INFORMATION_SCHEMA` routine/view/constraint catalogs and live
`sys.dm_exec_sessions` / `sys.dm_exec_requests`, `@@ROWCOUNT` / `@@IDENTITY` /
`SCOPE_IDENTITY()`, a large built-in function surface (strings, math,
date/time with MSSQL boundary semantics, CAST/CONVERT with styles), MSSQL
error numbers, offset-preserving `datetimeoffset` with UTC-normalized
comparison and exact TDS round trips, and declared case/accent/BIN2 collation
semantics. Embedded listeners support scrypt-hashed, hot-rotatable SQL logins
over required TLS, with explicit insecure mode reserved for development.

What's still missing is tracked in [TODO.md](TODO.md).

## Development

```sh
pnpm test         # eslint + tsc + vitest (unit, executable-SQL and tedious e2e)
pnpm vitest       # watch mode
```

Node ≥ 22.18 — TypeScript sources run natively via type stripping; no build
step. Repo conventions, architecture notes and protocol references live in
[`.agents/skills`](.agents/skills) as living documents.
