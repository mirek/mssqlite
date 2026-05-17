# SQLite Data Types Reference

SQLite uses **dynamic typing**: the datatype is associated with the *value*, not with the *column*. Declared column types are only "affinity" hints. This chapter covers everything an MSSQL-compatible front-end needs to map T-SQL types onto SQLite storage correctly.

## Storage Classes

Every value stored or manipulated has exactly one of five storage classes:

| Storage class | Meaning |
|---|---|
| `NULL` | The NULL value. |
| `INTEGER` | Signed integer, stored in 0, 1, 2, 3, 4, 6, or 8 bytes (variable). In memory always promoted to 8-byte signed (range -9223372036854775808..9223372036854775807). |
| `REAL` | IEEE 754 binary64 (double precision). |
| `TEXT` | String in the database encoding (UTF-8 / UTF-16BE / UTF-16LE per `PRAGMA encoding`). |
| `BLOB` | Bytes stored exactly as input. |

Any column except `INTEGER PRIMARY KEY` (in a non-STRICT, rowid table) and columns in STRICT tables may hold a value of *any* storage class regardless of declared type. "Storage class" and "datatype" are mostly interchangeable terms.

There is also the abstract concept of **affinity** (TEXT, NUMERIC, INTEGER, REAL, BLOB) which applies to columns — see below.

## Type Affinity

Affinity is the **recommended** (not enforced, except in STRICT tables) storage class for a column. The five affinities are:

- `TEXT`
- `NUMERIC`
- `INTEGER`
- `REAL`
- `BLOB` (historically called "NONE")

### Affinity Determination Algorithm

For non-STRICT tables, the affinity of a column is derived from its declared type string by these rules, applied **in order** (first match wins):

1. If the declared type contains `"INT"` → **INTEGER** affinity.
2. Else if the declared type contains `"CHAR"`, `"CLOB"`, or `"TEXT"` → **TEXT** affinity.
3. Else if the declared type contains `"BLOB"`, or no type was declared → **BLOB** affinity.
4. Else if the declared type contains `"REAL"`, `"FLOA"`, or `"DOUB"` → **REAL** affinity.
5. Otherwise → **NUMERIC** affinity.

The matching is case-insensitive substring match. Parenthesized arguments (e.g. `VARCHAR(255)`) are ignored — SQLite imposes **no** length restrictions.

Surprises caused by the order:

- `"CHARINT"` → INTEGER (rule 1 wins over rule 2).
- `"FLOATING POINT"` → INTEGER (contains "INT").
- `"STRING"` → NUMERIC (matches no name rule).

### Common Type Name Mappings

| Declared type | Affinity | Rule |
|---|---|---|
| `INT`, `INTEGER`, `TINYINT`, `SMALLINT`, `MEDIUMINT`, `BIGINT`, `UNSIGNED BIG INT`, `INT2`, `INT8` | INTEGER | 1 |
| `CHARACTER(n)`, `VARCHAR(n)`, `VARYING CHARACTER(n)`, `NCHAR(n)`, `NATIVE CHARACTER(n)`, `NVARCHAR(n)`, `TEXT`, `CLOB` | TEXT | 2 |
| `BLOB`, *(no type)* | BLOB | 3 |
| `REAL`, `DOUBLE`, `DOUBLE PRECISION`, `FLOAT` | REAL | 4 |
| `NUMERIC`, `DECIMAL(p,s)`, `BOOLEAN`, `DATE`, `DATETIME` | NUMERIC | 5 |

### Affinity Behavior On INSERT

- **TEXT affinity**: stores values as NULL/TEXT/BLOB. Numeric inputs are converted to text.
- **NUMERIC affinity**: text that is a well-formed integer literal → INTEGER; well-formed real literal → REAL; integer literal too big for int64 → REAL. Hexadecimal integer literals (e.g. `'0x10'`) are *not* well-formed for this purpose and are stored as TEXT. A REAL that exactly represents an integer is folded into INTEGER (so `'3.0e+5'` is stored as integer `300000`). NULL and BLOB pass through unchanged.
- **INTEGER affinity**: identical to NUMERIC on INSERT. Differs only inside `CAST`: `CAST(4.0 AS INT)` → `4` (INTEGER), `CAST(4.0 AS NUMERIC)` → `4.0` (REAL).
- **REAL affinity**: like NUMERIC, but integers are stored as REAL. (As an on-disk optimization small whole REALs may be packed as integers; transparent.)
- **BLOB affinity**: no coercion; value is stored in its native class.

```sql
CREATE TABLE t1(
    t  TEXT,     -- TEXT affinity
    nu NUMERIC,  -- NUMERIC affinity
    i  INTEGER,  -- INTEGER affinity
    r  REAL,     -- REAL affinity
    no BLOB      -- BLOB (no) affinity
);

INSERT INTO t1 VALUES('500.0','500.0','500.0','500.0','500.0');
-- typeof: text|integer|integer|real|text

INSERT INTO t1 VALUES(500.0,500.0,500.0,500.0,500.0);
-- typeof: text|integer|integer|real|real

INSERT INTO t1 VALUES(500,500,500,500,500);
-- typeof: text|integer|integer|real|integer

INSERT INTO t1 VALUES(x'0500',x'0500',x'0500',x'0500',x'0500');
-- typeof: blob|blob|blob|blob|blob   -- BLOBs ignore affinity

INSERT INTO t1 VALUES(NULL,NULL,NULL,NULL,NULL);
-- typeof: null|null|null|null|null
```

### Effective Storage Matrix (Non-STRICT)

| Declared affinity | Storage classes that may end up there |
|---|---|
| INTEGER | INTEGER, REAL, TEXT, BLOB |
| REAL | REAL, TEXT, BLOB |
| TEXT | TEXT, BLOB |
| BLOB (none) | INTEGER, REAL, TEXT, BLOB |

(REAL/INTEGER cannot stay TEXT in TEXT columns because they always convert cleanly to text; BLOBs never convert.)

### Affinity of Expressions

- A simple column reference has the affinity of the column.
- `(X)` (parenthesized) is still a column reference.
- *Any* operator applied to a column, **including unary `+`**, strips affinity. Hence `+X` has no affinity. This is the canonical trick for forcing a comparison to occur with no affinity applied (see e.g. `IN (x,y,z)` semantics below).
- `CAST(expr AS type)` has the affinity that the type name would have on a column.
- `COLLATE` preserves left operand's affinity.
- Otherwise, an expression has **no affinity**.

VIEW / subquery columns get affinity from their result expression. For compound SELECTs (`UNION`, etc.) the affinity is taken from one of the legs **non-deterministically** — never rely on it.

## INTEGER PRIMARY KEY / Rowid Alias

In a normal (rowid) table, a column declared exactly as `INTEGER PRIMARY KEY` (case-insensitive, no other affinity-changing suffix) is an **alias for the implicit `rowid`**:

- Must always be a non-NULL 64-bit integer.
- Inserting NULL auto-generates a unique integer (this is how `AUTOINCREMENT`-less auto-IDs work).
- It is the only column whose type is *rigidly* enforced in non-STRICT tables.
- `INT PRIMARY KEY` (just `INT`) is **not** a rowid alias — only the exact word `INTEGER`. The column "INTEGER" as a bare keyword is parsed as an *identifier* in `CREATE TABLE tableZ(INTEGER PRIMARY KEY);` — so that column has no datatype and is NOT a rowid alias.
- In STRICT tables, `INTEGER PRIMARY KEY` is also a rowid alias; `INT PRIMARY KEY` is not.

For `WITHOUT ROWID` and STRICT tables, NULLs are properly disallowed in PRIMARY KEY columns. In ordinary tables, PRIMARY KEY columns *other than* INTEGER PRIMARY KEY may contain NULLs (historical bug; add `NOT NULL` to fix).

## Type Conversion Rules

### Comparison Coercion

Sort order ignoring affinity:

1. NULL is less than everything (including other NULLs for ordering purposes; equality is different — see below).
2. Any INTEGER/REAL < any TEXT < any BLOB.
3. INTEGER vs REAL compare numerically.
4. TEXT vs TEXT uses the chosen collating sequence.
5. BLOB vs BLOB uses `memcmp()`.

Before comparing, SQLite **applies affinity** to coerce operands. "Apply affinity X" means: convert to X *if and only if* it can be done losslessly. Numerics always convert to TEXT; TEXT converts to numeric only if it is a well-formed int/real literal (not hex); BLOBs convert to TEXT by reinterpreting the bytes in the database encoding.

Rules, in order:

1. If one operand has `INTEGER`/`REAL`/`NUMERIC` affinity and the other has `TEXT`/`BLOB`/no affinity → apply NUMERIC to the other.
2. Else if one operand has TEXT affinity and the other has no affinity → apply TEXT to the other.
3. Otherwise no affinity is applied; compare as-is.

Special cases:

- `BETWEEN b AND c` is `>= b AND <= c` — each comparison applies affinity independently.
- `x IN (SELECT y …)` is handled as `x = y`.
- `x IN (v1, v2, …)` is equivalent to `x = +v1 OR x = +v2 OR …` — the RHS values are stripped of affinity (no coercion of RHS).

```sql
CREATE TABLE t1(a TEXT, b NUMERIC, c BLOB, d);
INSERT INTO t1 VALUES('500','500','500',500);
-- stored: TEXT, INTEGER, TEXT, INTEGER

SELECT a < 40,   a < 60,   a < 600 FROM t1;  -- 0|1|1  (RHS coerced to TEXT)
SELECT b < 40,   b < 60,   b < 600 FROM t1;  -- 0|0|1  (numeric)
SELECT c < 40,   c < 60,   c < 600 FROM t1;  -- 0|0|0  (INTEGER < TEXT always)
SELECT d < '40', d < '60', d < '600' FROM t1;-- 1|1|1  (INTEGER < TEXT always)
```

Notably, `SELECT 1='1';` returns **false** in SQLite (unlike every other major engine) because neither side has affinity and storage classes differ.

### Arithmetic Coercion

Math operators (`+ - * / % << >> & |`) interpret operands as numbers:

- TEXT/BLOB convert to REAL if they look like a real or are out of int64 range; otherwise to INTEGER.
- This differs from `CAST(... AS NUMERIC)`: strings like `'3.0'` stay REAL here (no integer fold).
- The conversion proceeds even if lossy.
- `% << >> & |` force INTEGER (REAL is `CAST` to INT).
- Bitwise / shifts always return INTEGER (or NULL). `%` returns REAL or INTEGER per operand types.
- Any NULL operand → NULL result.
- A non-numeric, non-NULL operand becomes `0` or `0.0`.
- Division by zero → NULL.

### INSERT Coercion

Apply the column's affinity to the value as described above. In **STRICT** tables, if the value cannot be losslessly coerced to the column's declared type, the engine raises `SQLITE_CONSTRAINT_DATATYPE`.

## STRICT Tables

Created by appending `STRICT` after the closing `)` of `CREATE TABLE`:

```sql
CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, val ANY) STRICT;
```

Differences from ordinary tables:

1. **Every column must declare a datatype** — no untyped columns.
2. The allowed datatype keywords are exactly:
   - `INT`
   - `INTEGER`
   - `REAL`
   - `TEXT`
   - `BLOB`
   - `ANY`

   No other names accepted (no `VARCHAR`, no `DECIMAL`, no `BIGINT`, no `BOOLEAN`, no `DATETIME`).
3. Inserts/updates must be of the declared type (or NULL when allowed). SQLite still attempts lossless affinity coercion (like Postgres/MySQL/MSSQL/Oracle). If coercion is lossy, `SQLITE_CONSTRAINT_DATATYPE` is raised.
4. **ANY** columns accept any storage class with **no coercion at all** — `'000123'` stays as TEXT `'000123'` (in non-STRICT a hypothetical ANY column would have coerced it to integer `123`).
5. PRIMARY KEY columns are implicitly NOT NULL (including text PKs). `INTEGER PRIMARY KEY` is still the rowid alias and NULL insertion auto-assigns an integer; `INT PRIMARY KEY` is not.
6. `PRAGMA integrity_check` and `PRAGMA quick_check` will detect any type mismatch in STRICT tables.

Everything else (`CHECK`, `NOT NULL`, `FOREIGN KEY`, `UNIQUE`, `DEFAULT`, `COLLATE`, generated columns, `ON CONFLICT`, indexes, `AUTOINCREMENT`, on-disk format) works identically.

## Date and Time Storage

SQLite has **no** dedicated date/time storage class. The built-in date/time functions accept and produce three formats; pick one per column:

- **TEXT** in ISO-8601 form: `'YYYY-MM-DD HH:MM:SS.SSS'` (or just date, or with `T` separator).
- **REAL** as Julian day number (days since noon UTC, 24 Nov 4714 BC proleptic Gregorian).
- **INTEGER** as Unix time (seconds since 1970-01-01 00:00:00 UTC).

Recommendation for MSSQL compatibility (`DATETIME`, `DATETIME2`, `SMALLDATETIME`, `DATE`, `TIME`): use TEXT ISO-8601 with sufficient sub-second precision. This preserves lexicographic sort order, round-trips through string-based protocols cleanly, and is human-readable. Note: an MSSQL-declared column of type `DATETIME` ends up with **NUMERIC** affinity in SQLite — values like `'2024-01-01'` stay TEXT (not a numeric literal) but values that look numeric will be converted. Consider using STRICT tables with `TEXT` declared type to lock this down.

## Boolean Representation

There is **no BOOLEAN storage class**. Booleans are stored as integers `0` (false) and `1` (true). The keywords `TRUE` and `FALSE` (since 3.23.0) are aliases for integer literals `1` and `0`. If you `CREATE TABLE t(flag BOOLEAN)`, the column has **NUMERIC** affinity.

T-SQL `BIT` should map to a SQLite integer (preferably constrained `CHECK (col IN (0,1))` and stored as INTEGER).

## Real Number Precision and Quirks

- REAL = IEEE 754 binary64. Range ≈ ±1.7976931348623157e+308; smallest positive subnormal ≈ 4.9406564584124654e-324; also ±0, ±Inf, NaN.
- ≈ **15.95 significant decimal digits** of precision. Floating point is **approximate**: most decimal fractions (e.g. `47.49`) are not exactly representable.
- When converting REAL → text for display, SQLite rounds:
  - SQLite ≤ 3.51.2: rounds to 15 digits (human-friendly but may not round-trip exactly).
  - SQLite ≥ 3.52.0 (default): tries 15 digits, but if that wouldn't round-trip back to the original binary64 value it falls back to 17 digits. Set with `sqlite3_db_config(db, SQLITE_DBCONFIG_FP_DIGITS, n, 0)` (`n` = 15 or 17, or 0 for default).
- Implication for MSSQL `FLOAT`/`REAL`: this matches SQL Server's `FLOAT(53)` (binary64). `REAL` in MSSQL is binary32 — narrow before storing only if explicit precision matters.
- For exact decimal arithmetic (T-SQL `DECIMAL(p,s)`/`NUMERIC(p,s)`) the SQLite `decimal` extension (`decimal_add`, `decimal_sub`, `decimal_mul`, `decimal_cmp`, `decimal_sum`, `decimal` collating sequence) operates on text-stored arbitrary-precision values. Store such columns as TEXT (in STRICT mode) and compute via the extension, otherwise expect rounding errors.

## BLOB Handling

- BLOBs are stored byte-for-byte as input.
- BLOBs are never auto-converted on INSERT (regardless of column affinity) and never coerced on comparison (other than the reinterpret-as-text rule for cross-class compares).
- BLOB literals use the `x'...'` syntax: `x'48656C6C6F'`.
- BLOBs sort greater than all TEXT and are compared with `memcmp()`.
- Casting a BLOB to TEXT reinterprets the bytes in the database encoding (UTF-8 by default). For invalid UTF, see below.

T-SQL `VARBINARY`, `BINARY`, `IMAGE`, `ROWVERSION` → SQLite BLOB.

## Collation

When comparing TEXT, SQLite uses a collating sequence. Three built-in:

- **BINARY** (default): byte-wise `memcmp()` regardless of encoding.
- **NOCASE**: `BINARY` but with the 26 ASCII letters `A`–`Z` folded to `a`–`z` first. **Only ASCII** — no full Unicode case folding (compile with `-DSQLITE_ENABLE_ICU` and link ICU for that). Embedded `U+0000` terminates comparison early.
- **RTRIM**: `BINARY` but trailing space characters (`' '`) are ignored.

Additional collations register via `sqlite3_create_collation()`.

### Choice Of Collating Sequence

For a binary comparison operator (`=`, `<`, `>`, `<=`, `>=`, `!=`, `IS`, `IS NOT`):

1. If either operand has an explicit `COLLATE` modifier anywhere in its subexpression, that collation wins (leftmost wins on ties).
2. Else if either operand is a column reference (incl. unary `+`/`CAST` of one), use that column's defined collation, with left operand taking precedence.
3. Otherwise BINARY.

`BETWEEN` decomposes to two comparisons. `x IN (SELECT y …)` uses `x` vs `y` rules. `x IN (v1, v2, …)` uses `x`'s collation; force via `x COLLATE nocase IN (…)`.

`ORDER BY <column>` uses the column's collation; `ORDER BY <expr>` (non-column) uses BINARY unless `COLLATE` is applied.

```sql
CREATE TABLE t1(
    x INTEGER PRIMARY KEY,
    a,                 -- BINARY (default)
    b COLLATE BINARY,
    c COLLATE RTRIM,
    d COLLATE NOCASE
);
```

Collations only affect TEXT comparisons. Numeric comparisons always use numeric ordering; BLOBs always use `memcmp()`.

### MSSQL Collation Mapping

T-SQL has rich collations (e.g. `SQL_Latin1_General_CP1_CI_AS`). SQLite has only the three above. Practical mapping:

- `*_CI_*` (case-insensitive) → `NOCASE` for ASCII-only data; otherwise register a custom collation.
- `*_AS` / `_BIN` → `BINARY`.
- Accent/width sensitivity, locale-specific orderings: require a custom collation registered through `sqlite3_create_collation()`.

## NULL Semantics

- Any arithmetic, bitwise, or string operation with a NULL operand yields NULL (`x + NULL` = NULL, `NULL * 0` = NULL, `NULL || 'x'` = NULL).
- Comparison with NULL using `=`, `<>`, `<`, etc. yields NULL, **not** TRUE/FALSE. Use `IS NULL` / `IS NOT NULL` / `IS` / `IS NOT` to compare against NULL distinctly.
- Boolean logic is three-valued: `NULL OR TRUE` = TRUE; `NULL AND FALSE` = FALSE; `NOT (NULL AND FALSE)` = TRUE; `NULL OR NULL` = NULL.
- `CASE WHEN NULL THEN 1 ELSE 0 END` evaluates to `0` (NULL test is treated as not-true, falls to ELSE) — matching MSSQL, Postgres, Oracle, etc.
- In **`SELECT DISTINCT`** and **`UNION`**, NULLs are treated as **indistinct** (collapsed together) — same as MSSQL/Postgres/Oracle.
- In **`UNIQUE`** constraints (and unique indexes), NULLs are **distinct** — multiple NULLs are allowed. This differs from MSSQL/Informix (which treat them as indistinct). For MSSQL-compatible UNIQUE-with-NULL behavior either (a) add `NOT NULL`, or (b) implement the constraint with a filtered unique index using a partial index `WHERE col IS NOT NULL` plus separate validation.
- For **`ORDER BY`**, NULL sorts as least (before all values) by default. Override with `NULLS FIRST` / `NULLS LAST`.
- For **`GROUP BY`**, all NULL values are grouped together (a single NULL group). No affinity is applied during GROUP BY.

Aggregate behavior with NULL (`count`, `sum`, `avg`, `min`, `max`): NULL inputs are **ignored** except `count(*)` which counts rows including NULLs.

## Other Type-Relevant Quirks

- **Integer vs text literals are not interchangeable.** `SELECT 1='1'` returns `0` (false). Bind values respecting type.
- **NUL characters (` `) are permitted inside TEXT strings.** Functions and collations that treat them as terminators (such as NOCASE) may truncate comparisons there. Plan for full string lengths via `length()` (returns chars) vs `octet_length()` style logic.
- **Invalid UTF is preserved best-effort, not rejected.** SQLite is GIGO with regard to malformed UTF-8/UTF-16: it stores it, doesn't crash, and round-trips raw bytes only when no transformation (encoding conversion, `substr`, `replace`, `LIKE`) intervenes. Inserting a UTF-16 string with bad surrogates into a UTF-8 database may cause irrecoverable mangling. Identifier names with invalid UTF still work but error messages may echo them verbatim. For MSSQL servers that validate UTF, validate at the protocol/parsing layer before reaching SQLite.
- **Length limits aren't enforced.** `VARCHAR(50)` allows arbitrary length. Enforce with `CHECK(length(col) <= 50)` if MSSQL-compatible behavior is required, or use STRICT tables (which still don't enforce length but at least enforce type).
- **No FLOAT/REAL/DOUBLE/DECIMAL precision arguments.** `DECIMAL(10,2)` parses but the parenthesized args are discarded — column gets NUMERIC affinity, stored as INTEGER or REAL depending on the value.
- **Double-quoted strings.** `"foo"` is an identifier in standard SQL but SQLite historically falls back to treating it as a string literal if no matching identifier exists. Always disable for MSSQL compatibility via `sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DDL, 0, 0)` and `SQLITE_DBCONFIG_DQS_DML`.
- **Sorting/grouping does not coerce** across storage classes. `UNION`, `INTERSECT`, `EXCEPT` compare values **as-is** (no affinity applied). `GROUP BY` considers different storage classes distinct (except INTEGER ≡ REAL when numerically equal). Heterogeneous columns can therefore produce surprising groupings.

## Quick Recipes For MSSQL Compatibility

- **Force strict typing**: declare tables `STRICT` and use `ANY` for true variant columns; otherwise pick one of `INT`/`INTEGER`/`REAL`/`TEXT`/`BLOB`.
- **Map T-SQL types**:
  - `BIT` → `INTEGER` with `CHECK (col IN (0,1))`
  - `TINYINT`/`SMALLINT`/`INT`/`BIGINT` → `INTEGER`
  - `REAL` (binary32) → `REAL` (stored as binary64; widen)
  - `FLOAT(53)` → `REAL`
  - `DECIMAL(p,s)`/`NUMERIC(p,s)` → `TEXT` + `decimal` extension for exact math, or `REAL` if precision loss is acceptable
  - `MONEY`/`SMALLMONEY` → store as INTEGER scaled (e.g., ×10000) or as TEXT decimal
  - `CHAR(n)`/`VARCHAR(n)`/`NCHAR(n)`/`NVARCHAR(n)`/`TEXT`/`NTEXT` → `TEXT` (+ optional `CHECK(length(col) <= n)`)
  - `BINARY(n)`/`VARBINARY(n)`/`IMAGE` → `BLOB`
  - `DATE`/`TIME`/`DATETIME`/`DATETIME2`/`SMALLDATETIME`/`DATETIMEOFFSET` → `TEXT` ISO-8601
  - `UNIQUEIDENTIFIER` → `TEXT` (canonical form) or `BLOB(16)`
  - `XML`/`JSON` → `TEXT` (use SQLite JSON1 for JSON)
  - `ROWVERSION`/`TIMESTAMP` → `BLOB(8)` (with application-managed monotonic value) or `INTEGER`
  - `SQL_VARIANT` → STRICT-table `ANY` column
- **Force a numeric comparison** regardless of column affinity: `WHERE col + 0 = 123` (the `+ 0` strips column affinity and forces numeric on both sides). Equivalent unary form: use `CAST(col AS REAL)`.
- **Force a textual comparison**: `WHERE col || '' = '123'`.
- **Reject implicit conversion**: use STRICT tables and the application sets explicit parameter types via the SQLite C API binding functions (`sqlite3_bind_int64`, `_text`, `_blob`, `_double`, `_null`).
