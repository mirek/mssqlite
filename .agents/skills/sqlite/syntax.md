# SQLite Syntax Reference

This chapter is the lexical/expression reference for an MSSQL-compatible
server that delegates parsing and evaluation to SQLite. Use it when mapping
T-SQL constructs onto SQLite syntax and when verifying that round-tripped
SQL is parsable by both engines.

## Lexical Structure

### Whitespace

Space (0x20), tab (0x09), newline (0x0a), carriage return (0x0d), and form
feed (0x0c) separate tokens. Comments are treated as whitespace by the
parser. Whitespace inside identifiers and literals is significant only
within quoted strings.

### Comments

Two comment styles, neither of which nest:

```sql
-- line comment to next \n or end-of-input
/* C-style block comment, may span lines, terminated by */
```

Either form may appear anywhere whitespace is legal, including inside
expressions or between clauses of a statement.

### Identifiers

An identifier is a name for a table, index, column, view, trigger,
collation, virtual-table module, schema, function, savepoint, or window.

Unquoted identifiers must begin with a letter (A-Z, a-z) or underscore,
followed by letters, digits, or underscores. They are case-insensitive
(`Foo`, `FOO`, `foo` are the same name). An unquoted identifier that
matches an SQLite keyword (see below) is rejected in identifier position.

SQLite accepts **four** quoting styles for identifiers; the latter three
all denote the same identifier semantics:

```sql
"identifier"        -- standard SQL double-quoted
[identifier]        -- MS Access / SQL Server bracket form (MSSQL-style)
`identifier`        -- MySQL backtick form
'identifier'        -- single quotes; ONLY treated as identifier in
                    -- contexts where a string literal is not allowed
                    -- (legacy fallback; do not rely on it)
```

Two quoting "bend" rules exist for legacy compatibility and should not be
relied on:

- `'keyword'` is reinterpreted as an identifier if string literals are not
  allowed in that position.
- `"keyword"` is reinterpreted as a string literal if it cannot resolve to
  an identifier but a string literal is allowed.

For MSSQL emulation, prefer `[name]` from the wire and translate freely to
or from `"name"` internally; both are accepted by SQLite with identical
meaning. Schema and column names are always case-insensitive.

The special pseudo-column identifiers `ROWID`, `OID`, `_ROWID_` refer to
the implicit integer rowid of a table (not available on `WITHOUT ROWID`
tables). They are shadowed by any real column with the same name.

### Keywords

SQLite recognizes 147 reserved keywords. To use any of them as a name,
quote it with one of the four quoting styles above. The full keyword list:

```
ABORT, ACTION, ADD, AFTER, ALL, ALTER, ALWAYS, ANALYZE, AND, AS, ASC,
ATTACH, AUTOINCREMENT, BEFORE, BEGIN, BETWEEN, BY, CASCADE, CASE, CAST,
CHECK, COLLATE, COLUMN, COMMIT, CONFLICT, CONSTRAINT, CREATE, CROSS,
CURRENT, CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP, DATABASE,
DEFAULT, DEFERRABLE, DEFERRED, DELETE, DESC, DETACH, DISTINCT, DO, DROP,
EACH, ELSE, END, ESCAPE, EXCEPT, EXCLUDE, EXCLUSIVE, EXISTS, EXPLAIN,
FAIL, FILTER, FIRST, FOLLOWING, FOR, FOREIGN, FROM, FULL, GENERATED,
GLOB, GROUP, GROUPS, HAVING, IF, IGNORE, IMMEDIATE, IN, INDEX, INDEXED,
INITIALLY, INNER, INSERT, INSTEAD, INTERSECT, INTO, IS, ISNULL, JOIN,
KEY, LAST, LEFT, LIKE, LIMIT, MATCH, MATERIALIZED, NATURAL, NO, NOT,
NOTHING, NOTNULL, NULL, NULLS, OF, OFFSET, ON, OR, ORDER, OTHERS, OUTER,
OVER, PARTITION, PLAN, PRAGMA, PRECEDING, PRIMARY, QUERY, RAISE, RANGE,
RECURSIVE, REFERENCES, REGEXP, REINDEX, RELEASE, RENAME, REPLACE,
RESTRICT, RETURNING, RIGHT, ROLLBACK, ROW, ROWS, SAVEPOINT, SELECT, SET,
TABLE, TEMP, TEMPORARY, THEN, TIES, TO, TRANSACTION, TRIGGER, UNBOUNDED,
UNION, UNIQUE, UPDATE, USING, VACUUM, VALUES, VIEW, VIRTUAL, WHEN, WHERE,
WINDOW, WITH, WITHOUT
```

Any identifier that is *not* on this list is not a keyword. New keywords
may be added in future SQLite versions, so quote user-supplied identifiers
defensively.

`TRUE` and `FALSE` are boolean literals (since 3.23.0) but **not**
keywords: if a table or column named `TRUE` exists, the name resolves to
that object instead.

## Literals

A literal is a constant of type integer, real, text, blob, or null.

### Numeric Literals

```
123                 -- integer
0x1F  0X1f          -- hexadecimal integer (64-bit two's complement)
123.45              -- real
1.5e10  2E-3  .5    -- real with optional exponent (E or e)
1_000_000           -- since 3.46.0: underscore digit separators allowed
                    -- between any two digits, ignored by parser
```

A token with a decimal point, an exponent, or magnitude outside
[-9223372036854775808, 9223372036854775807] is a real literal; otherwise
integer. The decimal separator is always `.` (locale-independent).

Hex literals are recognized **only by the SQL parser**; they are not
recognized when coercing a TEXT value to INTEGER (CAST, affinity, etc.) —
such coercion stops at the `x` and yields 0.

### String Literals

```sql
'hello'             -- enclosed in single quotes
'it''s'             -- embedded single quote by doubling
```

Backslash escapes are **not** supported (non-standard). String literals
have no maximum length except SQLite limits.

### BLOB Literals

```sql
X'53514C697465'     -- 'X' or 'x' prefix, hex digits in single quotes
```

The hex string must have an even number of digits.

### NULL, TRUE, FALSE

```sql
NULL                -- the unknown / missing value
TRUE                -- alias for integer 1
FALSE               -- alias for integer 0
```

On the right-hand side of `IS`, `TRUE`/`FALSE` cause the LHS to be
evaluated as a boolean (truthiness rule, see Boolean Expressions below).

### Datetime Literals

There is no date/time type; these tokens are evaluated as text literals
at statement execution:

```sql
CURRENT_TIME        -- 'HH:MM:SS' UTC
CURRENT_DATE        -- 'YYYY-MM-DD' UTC
CURRENT_TIMESTAMP   -- 'YYYY-MM-DD HH:MM:SS' UTC
```

## Bind Parameters

Five wire-compatible parameter forms are accepted:

```
?           anonymous; number = max-assigned + 1
?NNN        explicit 1-based index (1 .. SQLITE_MAX_VARIABLE_NUMBER)
:name       named, also assigned a sequential number
@name       named (identical semantics to :name)
$name       named; permits Tcl-style suffix with '::' and '(...)'
```

Unbound parameters evaluate to NULL. Names are matched verbatim
(case-sensitive in the C API; the colon/at/dollar is part of the name).
Mixing `?` with named forms in a single statement is permitted but
discouraged.

For MSSQL emulation, T-SQL `@name` parameters map directly onto SQLite
`@name`; SQLite assigns them numeric positions in source order.

## Operators and Precedence

Operators listed top-to-bottom from **highest** to **lowest** precedence.
Operators in the same row share precedence; binary operators are
left-associative unless otherwise noted.

| Level | Operators |
|------:|-----------|
| 1 | `~` *expr*&nbsp;&nbsp;&nbsp;`+` *expr*&nbsp;&nbsp;&nbsp;`-` *expr* (unary) |
| 2 | *expr* `COLLATE` *collation-name* (postfix) |
| 3 | `||`&nbsp;&nbsp;&nbsp;`->`&nbsp;&nbsp;&nbsp;`->>` |
| 4 | `*`&nbsp;&nbsp;&nbsp;`/`&nbsp;&nbsp;&nbsp;`%` |
| 5 | `+`&nbsp;&nbsp;&nbsp;`-` (binary) |
| 6 | `&`&nbsp;&nbsp;&nbsp;`|`&nbsp;&nbsp;&nbsp;`<<`&nbsp;&nbsp;&nbsp;`>>` |
| 7 | *expr* `ESCAPE` *escape-char* (postfix; binds to preceding `LIKE`) |
| 8 | `<`&nbsp;&nbsp;&nbsp;`>`&nbsp;&nbsp;&nbsp;`<=`&nbsp;&nbsp;&nbsp;`>=` |
| 9 | `=`&nbsp;&nbsp;`==`&nbsp;&nbsp;`<>`&nbsp;&nbsp;`!=`&nbsp;&nbsp;`IS`&nbsp;&nbsp;`IS NOT`&nbsp;&nbsp;`IS DISTINCT FROM`&nbsp;&nbsp;`IS NOT DISTINCT FROM`&nbsp;&nbsp;*expr* `BETWEEN` *expr* `AND` *expr*&nbsp;&nbsp;`IN`&nbsp;&nbsp;`MATCH`&nbsp;&nbsp;`LIKE`&nbsp;&nbsp;`REGEXP`&nbsp;&nbsp;`GLOB`&nbsp;&nbsp;*expr* `ISNULL`&nbsp;&nbsp;*expr* `NOTNULL`&nbsp;&nbsp;*expr* `NOT NULL` |
| 10 | `NOT` *expr* |
| 11 | `AND` |
| 12 | `OR` |

Notes:

- Each of `BETWEEN`, `IN`, `GLOB`, `LIKE`, `MATCH`, `REGEXP` may be
  prefixed with `NOT` (`NOT IN`, `NOT LIKE`, etc.) with the same
  precedence and associativity as the bare keyword.
- `COLLATE` is a postfix unary operator; the collation name applies to the
  immediately preceding expression and overrides any column-level
  collation.
- `ESCAPE` is postfix and only binds to a preceding `expr LIKE expr`.
- Unary `+` is a no-op (returns the operand unchanged, type preserved).
- `=` and `==` are equivalent. `!=` and `<>` are equivalent.
- `||` is string concatenation (joins two text values).
- `->` and `->>` are extract operators (default implementation: JSON
  subcomponent extraction; can be overridden).

### Arithmetic Details

- `%` casts both operands to INTEGER and returns the integer remainder.
- Other arithmetic operators do integer math when both operands are
  integers and no overflow occurs; otherwise IEEE 754 64-bit float.
- Integer division truncates toward zero.

### Comparison Details

All comparison operators return 1 (true), 0 (false), or NULL.

- `IS` / `IS NOT` behave like `=` / `!=` **except** they never return
  NULL: both-NULL → `IS` is 1, `IS NOT` is 0; one-NULL → `IS` is 0,
  `IS NOT` is 1. `IS NOT DISTINCT FROM` is a verbose alias for `IS`;
  `IS DISTINCT FROM` aliases `IS NOT`.
- `ISNULL`, `NOTNULL`, and `NOT NULL` are postfix forms equivalent to
  `IS NULL` and `IS NOT NULL`.
- `BETWEEN y AND z` is logically `>= y AND <= z`, but `x` is evaluated
  only once.

### Pattern Matching

```sql
x LIKE pattern [ESCAPE ch]    -- % = zero+ chars, _ = one char
                              -- case-insensitive for ASCII only by default
x GLOB pattern                -- Unix glob wildcards; case-sensitive
x REGEXP pattern              -- requires user-defined regexp() function
x MATCH pattern               -- requires user-defined match() function
```

`LIKE`, `GLOB`, `REGEXP`, `MATCH` each desugar to a function call:
`like(pattern, value [, esc])`, `glob(pattern, value)`,
`regexp(pattern, value)`, `match(pattern, value)`. Override the function
to change semantics. Each may be negated with `NOT` (e.g. `x NOT LIKE p`).

The `case_sensitive_like` pragma toggles ASCII case sensitivity for `LIKE`.

## Expression Forms

```
expr ::=
      literal-value
    | bind-parameter
    | [schema-name.]table-name.column-name
    | unary-op expr
    | expr binary-op expr
    | function-name(expr,...)
    | ( expr [, expr]* )                         -- row value
    | CAST(expr AS type-name)
    | expr COLLATE collation-name
    | expr [NOT] LIKE expr [ESCAPE expr]
    | expr [NOT] GLOB expr
    | expr [NOT] REGEXP expr
    | expr [NOT] MATCH expr
    | expr ISNULL | expr NOTNULL | expr NOT NULL
    | expr IS [NOT] expr
    | expr IS [NOT] DISTINCT FROM expr
    | expr [NOT] BETWEEN expr AND expr
    | expr [NOT] IN ( select-stmt | expr-list | empty )
    | expr [NOT] IN [schema-name.]( table | table-function(args) )
    | [NOT] EXISTS ( select-stmt )
    | CASE [base-expr]
        WHEN when-expr THEN then-expr ...
        [ELSE else-expr]
      END
    | RAISE ( IGNORE | (ROLLBACK|ABORT|FAIL), error-message )
```

### CAST

```sql
CAST(expr AS type-name)
```

Always converts (unlike column affinity, which is lossless-only). The
target affinity is derived from `type-name` (TEXT/REAL/INTEGER/NUMERIC/
NONE), not from a fixed type. Casting NULL gives NULL. CAST does not
recognize `0x`-style hex strings; conversion stops at `x` and yields 0.

### COLLATE

```sql
expr COLLATE collation-name
```

Postfix; assigns a collating sequence to `expr`, overriding any column-
level COLLATE. Built-in collations: `BINARY` (default), `NOCASE`
(ASCII-only case folding), `RTRIM` (trailing space stripped).

### CASE

```sql
-- Searched form: each WHEN is a boolean
CASE WHEN cond1 THEN r1
     WHEN cond2 THEN r2
     ELSE r3
END

-- Simple form: base is compared with = semantics to each WHEN
CASE base
     WHEN w1 THEN r1
     WHEN w2 THEN r2
     ELSE r3
END
```

Lazy evaluation. With no matching WHEN and no ELSE, result is NULL. In
the simple form, base-expression NULL → ELSE (or NULL). A NULL `WHEN`
result in the searched form is treated as untrue.

The built-in `iif(x, y, z)` is shorthand for
`CASE WHEN x THEN y ELSE z END`.

### IN / NOT IN

```sql
expr IN (v1, v2, ...)         -- list
expr IN (SELECT ...)          -- subquery
expr IN table-name            -- equivalent to IN (SELECT * FROM table)
expr IN table-func(args)
expr IN ()                    -- empty list, allowed; result is false
```

Empty RHS: `IN` is false, `NOT IN` is true, **regardless of LHS**, even
if LHS is NULL.

For non-empty RHS, the result follows this matrix (`-` = does not
matter):

| LHS NULL | RHS contains NULL | LHS found in RHS | `IN` | `NOT IN` |
|:--------:|:-----------------:|:----------------:|:----:|:--------:|
| no  | no  | no  | false | true  |
| no  | -   | yes | true  | false |
| no  | yes | no  | NULL  | NULL  |
| yes | -   | -   | NULL  | NULL  |

### EXISTS / NOT EXISTS

```sql
EXISTS (SELECT ...)
```

Always 0 or 1 — never NULL. Column count and NULL contents of returned
rows are irrelevant; only row count matters.

### Subqueries

A parenthesised `SELECT` is a subquery. Scalar subquery (single column,
zero or one row) substitutes the first row's value, or NULL if no rows.
Multi-column row-value subqueries are allowed only as operands of
comparison operators or on the RHS of an `UPDATE ... SET (...) = (...)`
clause whose LHS column list has the matching width. Correlated
subqueries (references to outer columns) are re-evaluated per outer row.

### Function Calls

```sql
func(arg1, arg2, ...)
func()
func(*)                                       -- aggregates: count(*)
aggregate-func(DISTINCT arg [, arg ...] [ORDER BY ...]) [FILTER (WHERE ...)]
window-func(args) [FILTER (WHERE ...)] OVER ( ... | window-name )
```

Common helpers relevant to MSSQL emulation:

```sql
COALESCE(x, y, ...)     -- first non-NULL argument; result NULL only if all NULL
NULLIF(x, y)            -- NULL if x = y, else x
IFNULL(x, y)            -- two-argument COALESCE
IIF(cond, t, f)         -- shorthand for CASE WHEN cond THEN t ELSE f END
```

## NULL Semantics (Three-Valued Logic)

SQLite implements SQL92 three-valued logic, matching PostgreSQL/Oracle
behavior with one calibrated exception (UNIQUE column treatment).

### Propagation Rules

Most operators return NULL when any operand is NULL.

```
NULL + anything           -> NULL
NULL * 0                  -> NULL          -- no short-circuit
NULL || 'x'               -> NULL
NULL = NULL               -> NULL          -- NOT true!
NULL <> NULL              -> NULL
NULL = 1, NULL <> 1, ...  -> NULL
```

Exceptions where NULL does **not** propagate:

- `NULL IS NULL` → 1 (true)
- `NULL IS NOT NULL` → 0 (false)
- `x IS y`, `x IS NOT y` — never NULL (see above)
- `x IS DISTINCT FROM y`, `x IS NOT DISTINCT FROM y` — never NULL
- `NULL OR TRUE` → 1 (true)
- `NULL AND FALSE` → 0 (false)
- `EXISTS (...)` — always 0 or 1
- `COUNT(*)` and `COUNT(non-null-expr)` — never NULL (0 if empty)
- Empty-set `IN (...)` → false; empty-set `NOT IN (...)` → true

### Boolean Conversion

A WHERE/HAVING/ON/CASE-WHEN/USING/trigger-WHEN clause needs a boolean
result. To convert a value to boolean, SQLite first applies NUMERIC
affinity, then:

- `0` or `0.0` → false
- `NULL` → NULL (treated as untrue — row not selected, branch not
  taken)
- any other value → true

Examples of false: `0`, `0.0`, `'english'`, `'0'`, `''` (numerically 0).
Examples of true: `1`, `0.1`, `-0.1`, `'1english'`.

### NULL in CASE

```
CASE WHEN NULL THEN 1 ELSE 0 END    -- evaluates to 0
```

A NULL WHEN result is treated as untrue.

### NULL in DISTINCT / UNION / GROUP BY / ORDER BY

NULLs are **indistinct** for `SELECT DISTINCT`, `UNION`, `GROUP BY`, and
ordering — all NULLs are treated as one group / one duplicate value.
Default ordering places NULLs first for ASC, last for DESC; override with
`NULLS FIRST` / `NULLS LAST` on `ORDER BY`.

### NULL in UNIQUE Indexes

NULLs are **distinct** in a `UNIQUE` index — any number of rows may have
NULL in a UNIQUE column. This differs from MSSQL, which treats NULLs as
duplicates in a UNIQUE index. A null-safe expression key such as
`(col IS NULL), ifnull(col, 0)` emulates SQL Server without forbidding NULL;
the first component prevents the sentinel from colliding with a real value.
For composite keys, expand every component independently and retain any
collation-normalization expression inside the pair.

### NULL in Primary Keys

The single-column `INTEGER PRIMARY KEY` (an alias for rowid) rejects
NULL. Other declared `PRIMARY KEY` columns historically allowed NULL
unless `NOT NULL` was specified — a long-standing bug retained for
compatibility. `WITHOUT ROWID` tables enforce `NOT NULL` on PK columns.

### Arithmetic / Aggregate Edge Cases

```
sum(col)        -- NULL if all rows NULL; ignores NULL inputs
count(*)        -- counts all rows including NULLs
count(col)      -- counts non-NULL values
avg, min, max   -- ignore NULL; return NULL only if all input NULL
```

## Name Resolution

A schema-qualified object reference has up to three parts:

```
schema-name.table-name.column-name
schema-name.table-name
table-name.column-name
column-name
```

Schemas are `main`, `temp`, or any `ATTACH`-ed schema name. Schema names
are case-insensitive.

Resolution order when a schema is **not** specified:

1. `temp`
2. `main`
3. each attached database, in attach order

The first match wins. With a schema specified, only that schema is
searched. When the reference appears in a context that admits only one
object type (e.g. `DROP TABLE`), objects of other types in the same
schema are ignored, allowing same-named index/trigger/view to coexist
with the resolved table.

Within an expression, an unqualified column name resolves against the
columns of all tables in the enclosing FROM clauses; ambiguity is an
error. Table aliases (`FROM t AS a`) take effect — once aliased, the
original table name is not available as a qualifier.

For MSSQL compatibility:

- T-SQL `db.schema.table` is three-part; SQLite collapses this to a
  two-part `schema.table` (one logical level of schema, since each
  attached file is one "database"). Map the T-SQL `dbo` schema to
  `main` and ignore the database tier, or attach each "database" as a
  schema.
- `dbo.MyTable` from a client should be rewritten to either `MyTable`
  (relying on the search path) or `main.MyTable`.
- `[server].[db].[schema].[table]` (four-part) is not representable;
  reject or strip leading components.

## Quick-Reference Cheatsheet

```sql
-- Identifiers (interchangeable inside SQLite)
"customer id"     [customer id]     `customer id`

-- Literals
123  0xFF  3.14  1.5e-2  1_000_000
'O''Brien'        X'DEADBEEF'        NULL  TRUE  FALSE
CURRENT_DATE  CURRENT_TIME  CURRENT_TIMESTAMP

-- Bind parameters
?  ?1  ?42  :name  @name  $name

-- NULL-safe equality
a IS NOT DISTINCT FROM b           -- true if both NULL or both equal
a IS DISTINCT FROM b               -- inverse

-- Type coercion
CAST(x AS INTEGER)   CAST(x AS TEXT)   CAST(x AS BLOB)   CAST(x AS REAL)

-- Pattern tests
name LIKE 'A%'   name GLOB '[A-Z]*'   name REGEXP '^[A-Z]'

-- Conditional
COALESCE(a, b, c)   NULLIF(a, b)   IFNULL(a, b)   IIF(cond, y, n)
CASE WHEN cond THEN x ELSE y END

-- Comments
-- single line
/* block, no nesting */
```
