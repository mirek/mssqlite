# @mssqlite/transpile

T-SQL AST → SQLite SQL. Pure renderers over [`@mssqlite/tsql`](../tsql) ASTs;
every emitted statement is exercised against a real `node:sqlite` database in
this package's tests.

## API

```ts
import { parseStatement } from '@mssqlite/tsql'
import { statement } from '@mssqlite/transpile'

const { sql, variables } = statement(parseStatement(
  'SELECT TOP 5 * FROM dbo.users WHERE age >= @age'
))
// sql       → 'SELECT * FROM "users" WHERE ("age" >= @age) LIMIT 5'
// variables → [ '@age' ]
```

- `statement(ast)` — renders directly executable statements (SELECT, INSERT,
  UPDATE, DELETE, TRUNCATE, DDL) to `{ sql, variables }`. Control flow,
  DECLARE/SET, transactions and EXEC are interpreted by
  [`@mssqlite/engine`](../engine) instead.
- `scalar(ast)` — renders a single expression (engine uses it for variable
  initializers, IF/WHILE conditions, PRINT).
- `UnsupportedError` — thrown for constructs with no SQLite story
  (MERGE, PIVOT, …); the engine maps it to an MSSQL error response.

## Mapping decisions

- **Names** — database qualifiers and the `dbo` schema are dropped
  (`master.dbo.users` → `"users"`); `sys` / `INFORMATION_SCHEMA` objects
  flatten to lowercase names the catalog provides (`sys.Tables` →
  `"sys.tables"`); other schemas flatten into dotted identifiers
  (`app.users` → `"app.users"`); `#temp` tables land in SQLite's `temp`
  schema.
- **Variables** — `@x` stays a native SQLite `@x` parameter (lowercased);
  globals map to engine-bound parameters (`@@ROWCOUNT` → `@__rowcount`).
  Every rendered statement reports the variables it binds.
- **Collation** — char/text columns get `COLLATE NOCASE`, approximating the
  default `SQL_Latin1_General_CP1_CI_AS` case-insensitive comparisons.
- **`+`** — resolved by static type inference: numeric `+`, textual `||`,
  or the `mssqlite_add` UDF for dynamic dispatch when types are unknown.
- **IDENTITY** — becomes `INTEGER PRIMARY KEY AUTOINCREMENT` (rowid alias;
  ids never reused, like MSSQL). Non-PK identity columns are rejected.
- **TOP / OFFSET-FETCH** — become `LIMIT` / `LIMIT ... OFFSET`.
- **OUTPUT** — becomes `RETURNING` with the `inserted.` / `deleted.`
  qualifier stripped (INSERT and DELETE expose exactly those values;
  UPDATE only `inserted.`). `Output.readsDeleted` tells the engine when
  an UPDATE needs its pre-update snapshot path instead, and the wrong
  pseudo-table (`deleted` in INSERT, `inserted` in DELETE) is rejected,
  as is `$action` outside a MERGE statement.
- **Functions** — built-ins map to native SQLite (`isnull` → `ifnull`,
  `substring` → `substr`, `string_agg` → `group_concat`, `ceiling`, `power`,
  window functions, …), transpile-time rewrites (`YEAR(d)` →
  `CAST(strftime('%Y', d) AS INTEGER)`, `CHOOSE` → `CASE`, `QUOTENAME`,
  `EOMONTH`, `DATEFROMPARTS`), catalog subqueries (`OBJECT_ID`,
  `SCHEMA_NAME`, `DB_NAME(id)`, `IDENT_CURRENT`), or engine-registered
  `mssqlite_*` UDFs (`newid`, `dateadd`/`datediff`/`datepart`/`datename`,
  `charindex(3)`, `right`, `replicate`, `reverse`, `stuff`, `patindex`,
  `round`, `rand`, `datalength`, `isnumeric`, `isdate`,
  `scope_identity`, `db_name`, `suser_sname`, `serverproperty`, …).
  See the engine package for the UDF implementations.
- **CAST/CONVERT** — affinity casts, plus date/time renderings
  (`CAST(x AS date)` → `date(x)`) and CONVERT datetime styles
  (23, 101-126) via `strftime`.
- **DATEADD parts** — the bare datepart argument (`month`, `dd`, …)
  normalizes to a canonical literal at transpile time.
