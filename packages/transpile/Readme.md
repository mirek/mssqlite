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
  (procedural statements, MERGE, …); the engine maps it to an MSSQL error
  response or interprets the construct itself.

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
- **Table variables** — the engine resolves `@t` object references to
  collision-free temp-table names before calling the pure renderer.
- **Table-valued functions** — `STRING_SPLIT` adapts a JSON-array UDF
  through `json_each`, `OPENJSON` projects SQLite JSON1 rows to SQL Server's
  default or explicit schema, and `GENERATE_SERIES` uses a recursive CTE
  because Node's bundled SQLite omits the series extension. Rendered SELECTs
  carry declared column hints so empty results retain exact TDS metadata.
- **APPLY** — correlated two-argument STRING_SPLIT uses SQLite's implicit
  lateral virtual-table arguments; correlated simple `SELECT TOP (1)`
  derived sources become partitioned `ROW_NUMBER()` joins. CROSS uses INNER
  semantics, OUTER uses LEFT/NULL-extension semantics. Other TVFs, complex
  derived queries, and star projection over rewritten top-one sources fail
  cleanly rather than exposing helper columns or changing cardinality.
- **PIVOT / UNPIVOT** — PIVOT lowers to conditional aggregates grouped by
  every non-value/non-pivot input column. UNPIVOT materializes its source
  once and expands listed columns with `UNION ALL`, dropping NULL values.
  Duplicate output names and incompatible declared UNPIVOT types fail
  cleanly; generated SELECT metadata preserves aggregate/value types even
  for empty or all-NULL outputs.
- **Advanced grouping** — ROLLUP, CUBE, explicit/empty GROUPING SETS, and
  GROUPING() expand to ordered `UNION ALL` aggregate branches. Omitted group
  expressions become subtotal NULL placeholders while GROUPING returns 0/1.
  Duplicate sets remain duplicate; a simple source is materialized once so
  volatile derived expressions are not reevaluated per branch. Join sources
  currently repeat per branch, and DISTINCT/TOP/INTO/set-operation and
  OFFSET/FETCH combinations fail cleanly.
- **FOR JSON** — PATH aliases form nested JSON objects; AUTO keeps dotted
  aliases literal for one source and derives a root plus one joined child
  array from table aliases. SQLite `json_object`/`json_patch` and
  `json_group_array` implement escaping, NULL omission/inclusion, ROOT,
  empty arrays, and wrapper removal. JSON_QUERY and nested FOR JSON values
  are tagged with `json()` to avoid double encoding. AUTO joins beyond one
  root/child level are explicitly deferred.
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
