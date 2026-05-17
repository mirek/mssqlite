# SQLite Built-in Functions Reference

A dense lookup reference for SQLite's built-in scalar, date/time, math, and aggregate functions plus the `printf`/`format` substitution syntax. Use this when mapping T-SQL expressions to SQLite-compatible SQL on the server side.

Notes for MSSQL emulation:
- The Node.js `node:sqlite` module ships with `SQLITE_ENABLE_MATH_FUNCTIONS` enabled, so math functions are available by default.
- Statistical aggregates `STDEV`, `STDEVP`, `VAR`, `VARP` and any `PERCENTILE_*`/`MEDIAN` aggregates are **NOT built into core SQLite**. (`median`, `percentile`, `percentile_cont`, `percentile_disc` exist only when compiled with `-DSQLITE_ENABLE_PERCENTILE` in 3.51.0+, or as a loadable extension.) Implement these in user-defined functions if T-SQL clients need them.
- There is no built-in `STDEV`, `VARIANCE`, `STRING_AGG WITHIN GROUP` (ANSI), `STUFF`, `CHARINDEX`, `PATINDEX`, `LEN` (use `length`), `DATEPART`/`DATEADD`/`DATEDIFF` (use `strftime`/modifiers/`unixepoch` arithmetic), `ISNULL` (use `ifnull`), `GETDATE()` (use `datetime('now')`), `NEWID()` (use `lower(hex(randomblob(16)))` reshaped), `CONVERT`/`CAST` (use `CAST`), `TRY_CAST` (no equivalent — must catch error in host).

---

## Core scalar functions

| Signature | Description |
|---|---|
| `abs(X)` | Absolute value of numeric X. NULL if X is NULL. 0.0 if X is non-numeric string/blob. Overflow on `-9223372036854775808`. |
| `changes()` | Rows changed/inserted/deleted by the last INSERT/UPDATE/DELETE on this connection (excludes lower-level triggers). |
| `char(X1,...,XN)` | Returns a string composed of Unicode codepoints X1..XN. |
| `coalesce(X,Y,...)` | First non-NULL argument, else NULL. Requires >= 2 args. |
| `concat(X,...)` | Concatenates string representations of all non-NULL args. Empty string if all NULL. |
| `concat_ws(SEP,X,...)` | Concatenates non-NULL args after the first using SEP as separator. Returns NULL if SEP is NULL. |
| `format(FORMAT,...)` | printf-style formatting; see [printf section](#printf--format-specifiers). |
| `printf(FORMAT,...)` | Alias for `format()`. |
| `glob(X,Y)` | Equivalent to `Y GLOB X` (note: pattern X first, string Y second — reversed vs infix operator). |
| `hex(X)` | Upper-case hexadecimal rendering of X interpreted as BLOB. Numeric inputs are first stringified to UTF-8. |
| `ifnull(X,Y)` | First non-NULL of X,Y. Equivalent to 2-arg `coalesce`. |
| `iif(B1,V1,...,BN,VN[,ELSE])` / `if(...)` | Returns Vi for the first true Bi; optional trailing ELSE when arg count is odd. Short-circuits. Equivalent to a CASE expression. |
| `instr(X,Y)` | 1-based index of first occurrence of Y in X, 0 if not found. NULL if either arg is NULL. Operates on bytes if both are BLOB. |
| `last_insert_rowid()` | ROWID of the last inserted row on this connection. |
| `length(X)` | For strings: number of Unicode codepoints up to first NUL. For BLOBs: number of bytes. Use `octet_length` for byte length of strings. |
| `like(X,Y)` / `like(X,Y,Z)` | Equivalent to `Y LIKE X [ESCAPE Z]` (pattern X first, string Y second). |
| `likelihood(X,Y)` | No-op returning X; hints query planner that X is true with probability Y (0.0–1.0 constant). |
| `likely(X)` | No-op = `likelihood(X,0.9375)`. |
| `unlikely(X)` | No-op = `likelihood(X,0.0625)`. |
| `load_extension(X[,Y])` | Loads a shared-library extension. Disabled by default; requires `sqlite3_enable_load_extension()`. Returns NULL. |
| `lower(X)` | ASCII-only lower-case. Load ICU for full Unicode. |
| `ltrim(X[,Y])` | Strips any chars in Y from the left of X. Strips spaces if Y omitted. |
| `max(X,Y,...)` | Scalar form (≥2 args): largest argument using leftmost defined collation, BINARY otherwise. NULL if any arg is NULL. (Single-arg form is the aggregate.) |
| `min(X,Y,...)` | Scalar form (≥2 args): smallest argument. Same collation rules as `max`. |
| `nullif(X,Y)` | X if X≠Y, else NULL. Collation rules as `min`/`max`. |
| `octet_length(X)` | Byte length of X in the database's text encoding (or blob byte count). Avoids reading large columns from disk. |
| `quote(X)` | SQL-literal text for X (quoted string with doubled quotes, hex literal for BLOB). Truncates strings at first embedded NUL. |
| `random()` | Pseudo-random INTEGER in `[-9223372036854775807, +9223372036854775807]` (deliberately excludes INT64_MIN). |
| `randomblob(N)` | N-byte BLOB of pseudo-random bytes; min 1 byte. Use with `hex()`/`lower()` for UUID-like IDs. |
| `replace(X,Y,Z)` | Replace every occurrence of Y in X with Z. BINARY collation. Returns X unchanged if Y is empty. |
| `round(X[,Y])` | Round X to Y digits after the decimal (default 0, negative treated as 0). Returns floating-point. |
| `rtrim(X[,Y])` | Strips any chars in Y from the right of X. Strips spaces if Y omitted. |
| `sign(X)` | -1, 0, or +1 for negative/zero/positive numeric X. NULL for NULL/BLOB/non-numeric strings. |
| `soundex(X)` | Soundex encoding. `"?000"` for NULL or no ASCII alpha. **Only present if compiled with `SQLITE_SOUNDEX`** (not default). |
| `sqlite_compileoption_get(N)` | N-th compile-time option, NULL if out of range. |
| `sqlite_compileoption_used(X)` | 1/0 whether compile-time option named X was used. |
| `sqlite_offset(X)` | Byte offset in db file of the record from which X would be read; NULL if X is not a column of an ordinary table. **Requires `-DSQLITE_ENABLE_OFFSET_SQL_FUNC`.** |
| `sqlite_source_id()` | Source checkin date/time + SHA3-256 hash of the build. |
| `sqlite_version()` | SQLite library version string. |
| `substr(X,Y[,Z])` / `substring(X,Y[,Z])` | Substring of X starting at character Y (1-based; negative counts from right), length Z (negative = abs(Z) chars preceding Y-th). Operates on bytes for BLOBs. |
| `total_changes()` | Total INSERT/UPDATE/DELETE row changes since connection opened. |
| `trim(X[,Y])` | Strips chars in Y from both ends. Strips spaces if Y omitted. |
| `typeof(X)` | One of `"null"`, `"integer"`, `"real"`, `"text"`, `"blob"`. |
| `unhex(X[,Y])` | Decode hex string X into BLOB. Y is a set of characters to ignore in X. NULL on any bad input. |
| `unicode(X)` | Numeric Unicode codepoint of first character of X. |
| `unistr(X)` | Decode backslash-escapes in X: `\XXXX`, `\+XXXXXX`, `\uXXXX`, `\UXXXXXXXX`; `\\` for literal backslash. Added 3.50.0. |
| `unistr_quote(X)` | Like `quote(X)` but escapes control chars `U+0001..U+001F` via JSON-style backslash escapes wrapped in `unistr(...)`. |
| `upper(X)` | ASCII-only upper-case. |
| `zeroblob(N)` | BLOB of N zero bytes; managed efficiently for later incremental BLOB I/O. |

---

## Date/time functions

SQLite has **no dedicated date/time datatype**. Values are stored as:
- ISO-8601 text (e.g. `'2025-05-29 14:16:00'`)
- Julian day number (REAL, days since `-4713-11-24 12:00:00`)
- Unix timestamp (INTEGER/REAL, seconds since `1970-01-01 00:00:00 UTC`) — must be tagged with the `'unixepoch'` or `'auto'` modifier for the function to interpret it as such.

All seven date/time functions accept a `time-value` followed by zero or more modifiers, evaluated left to right. If omitted, the time-value defaults to `'now'` (UTC). The `subsec`/`subsecond` modifier may appear in the first slot to mean "now" with subsecond precision.

### Functions

| Signature | Returns | Default output format |
|---|---|---|
| `date(tv, mod, ...)` | TEXT | `YYYY-MM-DD` |
| `time(tv, mod, ...)` | TEXT | `HH:MM:SS` (or `HH:MM:SS.SSS` with `subsec`) |
| `datetime(tv, mod, ...)` | TEXT | `YYYY-MM-DD HH:MM:SS` (or `.SSS` with `subsec`) |
| `julianday(tv, mod, ...)` | REAL | Fractional Julian day |
| `unixepoch(tv, mod, ...)` | INTEGER (REAL with `subsec`) | Seconds since 1970-01-01 UTC |
| `strftime(fmt, tv, mod, ...)` | TEXT | Caller-specified |
| `timediff(A, B)` | TEXT `(+|-)YYYY-MM-DD HH:MM:SS.SSS` | Human-readable diff such that `datetime(A) = datetime(B, timediff(A,B))`. No modifiers allowed; only ISO-8601 / Julian day inputs. |

Equivalences:
```
date(...)      ≡ strftime('%F', ...)
time(...)      ≡ strftime('%T', ...)
datetime(...)  ≡ strftime('%F %T', ...)
julianday(...) ≡ CAST(strftime('%J', ...) AS REAL)
unixepoch(...) ≡ CAST(strftime('%s', ...) AS INT)
```

### Time-value formats accepted

1. `YYYY-MM-DD`
2. `YYYY-MM-DD HH:MM`
3. `YYYY-MM-DD HH:MM:SS`
4. `YYYY-MM-DD HH:MM:SS.SSS`
5. `YYYY-MM-DDTHH:MM`
6. `YYYY-MM-DDTHH:MM:SS`
7. `YYYY-MM-DDTHH:MM:SS.SSS`
8. `HH:MM`
9. `HH:MM:SS`
10. `HH:MM:SS.SSS` (formats 8–10 assume date `2000-01-01`)
11. `'now'` (UTC, frozen for the duration of a single `sqlite3_step()` call)
12. `DDDDDDDDDD` — Julian day number (number); or unix timestamp if followed by `'unixepoch'`/`'auto'`

Formats 2–10 may have a trailing TZ: `Z`, or `±HH:MM` (subtracted to normalize to UTC).

### Modifiers (applied left to right)

| Modifier | Effect |
|---|---|
| `NNN days`, `NNN hours`, `NNN minutes`, `NNN seconds` | Add NNN time units (trailing `s` optional; NNN can be `+`/`-` float). |
| `NNN months`, `NNN years` | Add calendar months/years (subject to `ceiling`/`floor` for ambiguity). |
| `±HH:MM`, `±HH:MM:SS`, `±HH:MM:SS.SSS` | Time shift by HMS amount (sign optional). |
| `±YYYY-MM-DD`, `±YYYY-MM-DD HH:MM[:SS[.SSS]]` | Time shift by date(time) amount; sign mandatory. Applied year-then-month-then-day. |
| `ceiling` | Resolve month/year ambiguity to the later date (this is the default). |
| `floor` | Resolve ambiguity to the last day of the previous month. |
| `start of month` | Snap back to first day of month, `00:00:00`. |
| `start of year` | Snap back to Jan 1 of year, `00:00:00`. |
| `start of day` | Snap back to `00:00:00` of the current day. |
| `weekday N` | Advance forward to next weekday N (`0=Sunday`..`6=Saturday`); no-op if already there. |
| `unixepoch` | Reinterpret the preceding DDDDDDDDDD as seconds since 1970 (must immediately follow that time-value). |
| `julianday` | Force preceding DDDDDDDDDD to be Julian day (mostly a no-op; errors if format wrong). |
| `auto` | Choose Julian-day vs Unix-timestamp by magnitude. Ambiguous for the first 63 days of 1970. No-op for ISO-8601 text. |
| `localtime` | Treat left value as UTC, convert to local time (uses libc `localtime_r`). |
| `utc` | Treat left value as local time, convert to UTC. |
| `subsec` / `subsecond` | Increase resolution to milliseconds for `datetime()`, `time()`, `unixepoch()`, and the `%s` format in `strftime()`. As the first arg, implies `'now'`. |

### `strftime` format specifiers

| Spec | Meaning |
|---|---|
| `%d` | day of month: 01–31 |
| `%e` | day of month, no leading zero: 1–31 |
| `%f` | fractional seconds `SS.SSS` |
| `%F` | ISO date `YYYY-MM-DD` |
| `%G` | ISO 8601 year corresponding to `%V` |
| `%g` | 2-digit ISO 8601 year |
| `%H` | hour 00–24 |
| `%I` | hour for 12-hour clock 01–12 |
| `%j` | day of year 001–366 |
| `%J` | Julian day (fractional) |
| `%k` | hour, no leading zero, 0–24 |
| `%l` | `%I` without leading zero, 1–12 |
| `%m` | month 01–12 |
| `%M` | minute 00–59 |
| `%p` | "AM"/"PM" |
| `%P` | "am"/"pm" |
| `%R` | `HH:MM` |
| `%s` | seconds since 1970 |
| `%S` | seconds 00–59 |
| `%T` | `HH:MM:SS` |
| `%U` | week of year 00–53 (week 01 starts first Sunday) |
| `%u` | weekday 1–7 (Monday=1) |
| `%V` | ISO 8601 week of year |
| `%w` | weekday 0–6 (Sunday=0) |
| `%W` | week of year 00–53 (week 01 starts first Monday) |
| `%Y` | year 0000–9999 |
| `%%` | literal `%` |

Unsupported substitutions yield NULL.

### Examples

```sql
SELECT date();                                         -- today (UTC)
SELECT date('now','start of month','+1 month','-1 day'); -- last day of this month
SELECT datetime(1092941466, 'unixepoch', 'localtime');
SELECT unixepoch();                                    -- == strftime('%s')
SELECT unixepoch('subsec');                            -- ms-precision now (float)
SELECT julianday('now') - julianday('1776-07-04');     -- days since US Independence
SELECT date('now','start of year','+9 months','weekday 2'); -- first Tue of October
SELECT timediff('now','1809-02-12');                   -- human-readable age
```

Caveats: valid range `0000-01-01..9999-12-31`. DST/historical timezone rules depend on libc `localtime_r`. All internal math is Gregorian, no leap seconds (every day is 86400 s).

---

## Math functions

Available when SQLite is compiled with `-DSQLITE_ENABLE_MATH_FUNCTIONS` — **default in modern builds including Node.js `node:sqlite`**. Returns NULL on NULL/BLOB/non-numeric inputs and on domain errors (e.g. `sqrt(-1)`, `acos(2)`).

| Signature | Description |
|---|---|
| `acos(X)` | Arccosine (radians). |
| `acosh(X)` | Hyperbolic arccosine. |
| `asin(X)` | Arcsine (radians). |
| `asinh(X)` | Hyperbolic arcsine. |
| `atan(X)` | Arctangent (radians). |
| `atan2(Y,X)` | Arctangent of `Y/X`, quadrant-correct. |
| `atanh(X)` | Hyperbolic arctangent. |
| `ceil(X)` / `ceiling(X)` | Smallest integer ≥ X. |
| `cos(X)` | Cosine (X in radians). |
| `cosh(X)` | Hyperbolic cosine. |
| `degrees(X)` | Convert radians → degrees. |
| `exp(X)` | `e^X`. |
| `floor(X)` | Largest integer ≤ X. |
| `ln(X)` | Natural log. |
| `log(X)` | **Base-10 log** (PostgreSQL-compatible; differs from MSSQL's `LOG(X)` which is natural log). |
| `log(B,X)` | Base-B log of X. Argument order matches Postgres/MySQL (base first); **reversed vs SQL Server's `LOG(X, B)`**. |
| `log10(X)` | Base-10 log. |
| `log2(X)` | Base-2 log. |
| `mod(X,Y)` | Remainder of X/Y (works for floats; the `%` operator is integer-only). |
| `pi()` | π (~3.141592653589793). |
| `pow(X,Y)` / `power(X,Y)` | `X^Y`. |
| `radians(X)` | Convert degrees → radians. |
| `sin(X)` | Sine (radians). |
| `sinh(X)` | Hyperbolic sine. |
| `sqrt(X)` | Square root; NULL for negative X. |
| `tan(X)` | Tangent (radians). |
| `tanh(X)` | Hyperbolic tangent. |
| `trunc(X)` | Integer part of X, rounding toward zero. |

---

## Aggregate functions

Syntax: `agg-func ( [DISTINCT] expr [, expr]... [ORDER BY ordering-term, ...] ) [FILTER (WHERE expr)]`

- `DISTINCT` (only for single-argument aggregates) filters duplicate inputs before aggregation. E.g. `count(DISTINCT x)`.
- `FILTER (WHERE expr)` restricts the aggregate to rows where `expr` is true.
- `ORDER BY` inside an aggregate controls input order — relevant for order-sensitive aggregates (`group_concat`/`string_agg`, `json_group_array`, etc.); ignored for order-insensitive ones (`sum`, `count`, `max`, `min`, `avg`). With no ORDER BY, input order is arbitrary.

| Signature | Description |
|---|---|
| `avg(X)` | Mean of non-NULL X; always REAL; NULL if no non-NULL inputs. Computed as `total()/count()`; non-numeric strings/BLOBs treated as 0. |
| `count(X)` | Count of rows where X is not NULL. |
| `count(*)` | Total rows in the group. |
| `group_concat(X)` | Concatenate non-NULL X with `,` separator. |
| `group_concat(X,Y)` | Concatenate non-NULL X with Y as separator. |
| `string_agg(X,Y)` | Alias for `group_concat(X,Y)` (PostgreSQL/SQL Server compatible name). |
| `max(X)` | Aggregate maximum (single-arg form); NULL only if no non-NULL inputs. |
| `min(X)` | Aggregate minimum (single-arg form); NULL only if no non-NULL inputs. |
| `sum(X)` | Sum of non-NULL X; INTEGER if all inputs are integers, else REAL; **NULL when no non-NULL inputs** (SQL standard). Throws on integer overflow when all inputs are int/NULL. |
| `total(X)` | Like `sum` but always REAL and **returns 0.0 for empty input**. Never throws on overflow (may return ±Infinity or NULL for ambiguous-infinity sums). |
| `median(X)` | = `percentile_cont(X, 0.5)`. **Only in 3.51.0+ with `-DSQLITE_ENABLE_PERCENTILE`, or via loadable extension.** |
| `percentile(Y,P)` | Percentile with P in `[0.0, 100.0]`. Same compile-time constraints. |
| `percentile_cont(Y,P)` | Continuous percentile with P in `[0.0, 1.0]`. |
| `percentile_disc(Y,P)` | Discrete percentile — returns an actual input value (the smaller of the two candidates). |

Notable T-SQL gaps:
- `STDEV`, `STDEVP`, `VAR`, `VARP` → not present, must be added as user-defined aggregates.
- `STRING_AGG(expr, sep) WITHIN GROUP (ORDER BY ...)` → use `string_agg(expr, sep ORDER BY ...)`.
- `COUNT_BIG` → use `count`; SQLite already returns 64-bit.
- `CHECKSUM_AGG`, `GROUPING`, `GROUPING_ID` → not present.

Window-function form of these aggregates (`OVER (...)`) is supported.

---

## printf / format specifiers

Format string syntax:

```
% [flags] [width] [ . precision ] [length] type
```

`%%` outputs a literal `%`.

### Substitution types

| Type | Meaning |
|---|---|
| `d`, `i` | Signed decimal integer. |
| `u` | Unsigned decimal integer. |
| `f` | Floating-point, decimal notation. |
| `e`, `E` | Floating-point, exponential (`e`/`E` exponent char). |
| `g`, `G` | Floating-point, normal or exponential whichever is shorter. |
| `x`, `X` | Hexadecimal integer (lower/upper case). |
| `o` | Octal integer. |
| `s`, `z` | Zero-terminated string. NULL → empty string (in SQL `format`). `%s` and `%z` are interchangeable in `format()`. |
| `c` | In `format()`, takes a string and renders its first character. With precision N>1, repeats the character N times (SQLite-only). |
| `p` | Pointer as hex; in `format()` behaves like `%x`. |
| `n` | Ignored in `format()` (no argument consumed). |
| `q` | String with `'` doubled (safe inside single-quoted SQL literal). NULL → empty. |
| `Q` | Like `q` but wraps the result in `'...'`; NULL → unquoted `NULL`. |
| `w` | Like `q` but doubles `"` (safe inside `"…"` identifier). |

`%#q` / `%#Q` (alternate-form-1) add JSON-style backslash escapes for control chars U+0001..U+001F and wrap `%#Q` output in `unistr('...')`.

### Length modifiers

| Modifier | Meaning |
|---|---|
| *(none)* | `int`/`unsigned int` (32-bit) — only meaningful for C interfaces. |
| `l` | `long`/`unsigned long` (also 32-bit on modern systems). |
| `ll` | 64-bit integer (`sqlite3_int64`). |

`format()` (SQL) always uses 64-bit values, so length modifiers are ignored there.

### Width

- Number, or `*` to pull width from the next argument (negative ⇒ left-justify).
- Measured in bytes by default; in characters if the `!` flag is set.
- Value is right-justified and padded unless `-` flag.
- If the value is longer than the width, the full value is emitted.

### Precision

Introduced by `.` after width. May be `*`.

- `%s`, `%z`, `%q`, `%Q`, `%w`: max bytes (or chars with `!`) consumed from the argument.
- `%d`, `%i`, `%x`, `%X`, `%o`, `%p`: minimum number of digits (zero-padded).
- `%e`, `%E`, `%f`: digits after the decimal point.
- `%g`, `%G`: total significant digits (rounds up to 1 if 0).
- `%c`: repeats the character that many times.

### Flags

| Flag | Meaning |
|---|---|
| `-` | Left-justify within width. |
| `+` | Prefix `+` on non-negative signed numerics. |
| *space* | Prefix a space on non-negative signed numerics. |
| `0` | Zero-pad numerics to width. With this flag, floating-point `Infinity`/`NaN` render as `9.0e+999`/`null` (valid SQL/JSON literals). |
| `#` | Alternate-form-1: `%#g`/`%#G` strip trailing zeros; `%#f` suppresses negative sign on all-zero output (if `+` is absent); forces decimal point on FP conversions; `%#o`/`%#x`/`%#X` prefix `0`/`0x`/`0X`; `%#q`/`%#Q` escape control chars (with `unistr(...)` wrapper for `%#Q`). |
| `,` | Insert comma thousands separators in integer part of numerics (SQLite extension; e.g. `format('%,d', 2147483647)` → `"2,147,483,647"`). |
| `!` | Alternate-form-2: width/precision in characters (not bytes) for strings; 26 (not 16) significant digits and forced decimal point for floats. |

Limitations vs C printf: no positional `%n$` arguments; FP precision capped at 16 (26 with `!`) significant digits; `format()` ignores `%n` and length modifiers; `%z` ↔ `%s` in `format()`.
