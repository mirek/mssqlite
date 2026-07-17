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

- **Names** — database qualifiers become deterministic SQLite attachment
  aliases (`sales.dbo.users` → `"mssqlite_73616c6573"."users"`) while the
  `dbo` schema drops; `sys` / `INFORMATION_SCHEMA` objects
  flatten to lowercase names the catalog provides (`sys.Tables` →
  `"sys.tables"`); other schemas flatten into dotted identifiers
  (`app.users` → `"app.users"`); `#temp` tables land in SQLite's `temp`
  schema.
- **Variables** — `@x` stays a native SQLite `@x` parameter (lowercased);
  globals map to engine-bound parameters (`@@ROWCOUNT` → `@__rowcount`).
- **Computed columns** — result types are inferred from base/earlier columns,
  then definitions render as SQLite VIRTUAL or PERSISTED/STORED generated
  columns. Generated expression mode uses deterministic checked numeric UDFs.
- **Collations** — supported column and expression COLLATE names lower to
  deterministic Unicode normalization keys used by comparisons, LIKE/IN,
  ordering and indexes.
- **Unique NULLs** — every logical component of a unique key expands to a NULL
  flag plus a collision-safe value expression. CREATE TABLE constraints keep
  native SQLite enforcement and add a reserved supplemental index; explicit
  unique indexes use the expanded expression key directly. This gives SQL
  Server's repeated-NULL behavior without losing collation or temporal keys,
  and preserves filtered-index predicates.

Integer arithmetic renders `mssqlite_arithmetic(op, left, right, width)` so
operands execute once and the engine can enforce divide-by-zero/overflow and
session options. SUM and integer AVG render checked int aggregates, with a
BIGINT argument selecting their 64-bit variants; AVG truncates toward zero and
supports window execution through an inverse step. COUNT_BIG and aggregate
result hints retain bigint metadata even for zero. DECIMAL/NUMERIC literals, casts,
arithmetic, comparisons, ordering, and aggregates render exact-decimal UDFs;
operator results carry SQL Server-derived precision/scale hints to TDS. Every
rendered statement reports the variables it binds.

- **Implicit conversion** — one static precedence table selects common operand
  types for arithmetic, comparisons, BETWEEN/IN, simple/result CASE, compound
  SELECTs, and multi-row VALUES. Known incompatible pairs fail before SQLite;
  strict conversion UDFs preserve SQL Server error numbers instead of using
  SQLite storage-class comparison or permissive numeric casts. Integer casts
  also carry static or variable-declaration source type into the UDF so numeric
  values truncate toward zero while decimal-looking character text still raises
  245; projection hints retain the requested integer wire width.
- **Scalar projection descriptors** — literals, NULL, casts, CASE, common
  operators, aggregates/window functions, and supported scalar built-ins share
  one type/nullability/collation inference path. It preserves character and
  binary widths, decimal precision/scale, temporal scale, fixed families, and
  SQL Server's nullable-family metadata without allowing one specialized item
  to describe an unrelated projection.
- **SELECT INTO projection hints** — every named expression with a known type
  contributes its exact target descriptor; set-operation branches widen through
  the same precedence table and combine nullability before the engine creates
  the destination table.
- **Table variables** — the engine resolves `@t` object references to
  collision-free temp-table names before calling the pure renderer.
- **Table-valued functions** — `STRING_SPLIT` adapts a JSON-array UDF
  through `json_each`; `OPENJSON` feeds source-spanned root/row adapters through
  `json_each` and projects SQL Server's default or explicit schema; and
  `GENERATE_SERIES` uses a recursive CTE because Node's bundled SQLite omits
  the series extension. Rendered SELECTs carry declared column hints so empty
  results retain exact TDS metadata.
- **User functions** — unknown scalar names pass through to engine-registered
  SQLite callbacks. Before rendering, the engine expands persisted inline
  TVF calls to parameter-substituted derived SELECTs; correlated simple
  inline sources use the same equality-key APPLY lowering as derived tables.
- **APPLY** — correlated two-argument STRING_SPLIT and OPENJSON use SQLite's
  implicit lateral virtual-table arguments; correlated simple `SELECT TOP (1)`
  derived sources become partitioned `ROW_NUMBER()` joins. CROSS uses INNER
  semantics, OUTER uses LEFT/NULL-extension semantics. Other TVFs, complex
  derived queries, and star projection over rewritten top-one sources fail
  cleanly rather than exposing helper columns or changing cardinality.
- **VALUES table sources** — typed rows lower to native VALUES wrapped by a
  naming SELECT, with explicit SQL-precedence coercions. The same
  renderer covers FROM, joins, uncorrelated APPLY, CTE/subquery bodies, and
  MERGE USING without depending on SQLite's generated `columnN` names.
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
- **Scalar JSON** — ISJSON, JSON_VALUE and JSON_QUERY render engine UDFs rather
  than JSON1 extraction. JSON_VALUE/JSON_QUERY carry `nvarchar(4000)` hints so
  scalar, fragment and NULL results retain SQL Server wire metadata; the engine
  owns strict/lax validation and source-slice preservation.
- **Collation** — char/text columns get `COLLATE NOCASE`, approximating the
  default `SQL_Latin1_General_CP1_CI_AS` case-insensitive comparisons.
- **`+`** — resolved by static type inference: numeric `+`, textual `||`,
  or the `mssqlite_add` UDF for dynamic dispatch when types are unknown.
- **IDENTITY** — renders as an ordinary typed, non-null SQLite column;
  primary-key constraints remain independent. The engine injects generated or
  explicitly tracked values from its database-owned allocator, so non-key and
  decimal identities do not depend on SQLite rowid.
- **TOP / OFFSET-FETCH** — become `LIMIT` / `LIMIT ... OFFSET`.
- **OUTPUT** — becomes `RETURNING` with the `inserted.` / `deleted.`
  qualifier stripped (INSERT and DELETE expose exactly those values;
  UPDATE only `inserted.`). `Output.readsDeleted` tells the engine when
  an UPDATE needs its pre-update snapshot path instead, and the wrong
  pseudo-table (`deleted` in INSERT, `inserted` in DELETE) is rejected,
  as is `$action` outside a MERGE statement.
- **Functions** — built-ins map to native SQLite (`isnull` → `ifnull`,
  `string_agg` → `group_concat`, `ceiling`, `power`,
  window functions, …), transpile-time rewrites (`YEAR(d)` →
  `CAST(strftime('%Y', d) AS INTEGER)`, `CHOOSE` → `CASE`,
  `EOMONTH`, `DATEFROMPARTS`), catalog subqueries (`OBJECT_ID`,
  `SCHEMA_NAME`, `DB_NAME(id)`), or engine-registered
  `mssqlite_*` UDFs (`newid`, `dateadd`/`datediff`/`datepart`/`datename`,
  `substring`, `left`, `right`, `replicate`, `quotename`, `reverse`, `stuff`, `patindex`,
  `round`, `rand`, `datalength`, `isnumeric`, `isdate`,
  `scope_identity`, `ident_current`, `db_name`, `suser_sname`, `serverproperty`, …).
  ASCII and CHAR route through Windows-1252 UDFs instead of SQLite's Unicode
  `unicode()` and `char()` primitives. LIKE always routes through the effective
  SQL collation matcher so T-SQL bracket classes, ranges, negation, and ESCAPE
  work for literals and every declared/runtime expression source. LEN, UNICODE,
  NCHAR, SUBSTRING, LEFT, RIGHT, STUFF, and REVERSE use UTF-16 code-unit UDFs
  under the currently supported non-SC collations instead of SQLite code points.
  See the engine package for the UDF implementations.
- **CAST/CONVERT** — affinity casts, plus strict date/time conversion UDFs
  that validate civil/time ranges, preserve error 241, and return NULL for TRY
  variants. CONVERT datetime styles
  (23, 101-126) via `strftime`. DATETIMEOFFSET casts instead use the exact
  offset-preserving codec UDF; comparisons, IN/BETWEEN, ORDER BY, uniqueness,
  and indexes render a UTC-normalized key while result hints retain scale.
  Character casts retain char/varchar/nchar/nvarchar identity and width:
  omitted declaration widths default to 1, omitted CAST/CONVERT widths to 30,
  explicit casts truncate, and target-column storage rejects overflow with
  error 2628. Result hints carry these widths into TDS metadata.
  SQL_VARIANT casts pack/unpack a persistent base-type envelope; XML casts
  accept Unicode text, and hierarchyid/geometry/geography casts accept only
  native binary serialization. Unsupported special-type operators and methods
  fail explicitly instead of inheriting SQLite TEXT/BLOB behavior.
- **Date constructors** — DATEFROMPARTS and DATETIMEFROMPARTS render validated,
  NULL-propagating engine UDFs instead of SQLite `printf`; expression hints
  retain native date/datetime TDS metadata for values and NULL results.
- **DATEADD parts** — the bare datepart argument (`month`, `dd`, …)
  normalizes to a canonical literal at transpile time.
