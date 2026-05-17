# SQLite Limits, Quirks, and Differences from SQL Server

Reference for an MSSQL-compatible server backed by SQLite. Every section flags semantics that the T-SQL layer must rewrite, validate, or emulate.

## Implementation Limits

Default compile-time limits. Many can be lowered (never raised above the compile-time maximum) at runtime per-connection via `sqlite3_limit(db, SQLITE_LIMIT_*, n)`. The `max_page_count` limit is controlled via `PRAGMA max_page_count`.

| Limit | Default | Hard max | Runtime | Notes |
|---|---|---|---|---|
| `SQLITE_MAX_LENGTH` (string/BLOB bytes) | 1,000,000,000 (1 GB) | 2^31 - 3 = 2,147,483,645 | yes (`LIMIT_LENGTH`) | Also bounds total row size (each row is encoded as one BLOB internally). |
| `SQLITE_MAX_COLUMN` | 2000 | 32767 | yes (`LIMIT_COLUMN`) | Bounds table cols, index cols, view cols, SET terms, SELECT result cols, GROUP/ORDER BY terms, INSERT VALUES. Prepare is O(N^2) in column count. |
| `SQLITE_MAX_SQL_LENGTH` (bytes) | 1,000,000,000 | 1,000,000,000 | yes (`LIMIT_SQL_LENGTH`) | Use bound parameters for large literals. |
| Tables in a JOIN | 64 | 64 | no | Bitmap-based optimizer. Hard. |
| `SQLITE_MAX_EXPR_DEPTH` | 1000 | unlimited (0) | only if compiled >0 | Recursive descent. |
| `SQLITE_MAX_FUNCTION_ARG` | 1000 (was ~100 pre-3.48.0) | 32767 | yes (`LIMIT_FUNCTION_ARG`) | |
| `SQLITE_MAX_COMPOUND_SELECT` (terms in UNION/INTERSECT/EXCEPT chain) | 500 | n/a | yes (`LIMIT_COMPOUND_SELECT`) | |
| `SQLITE_MAX_LIKE_PATTERN_LENGTH` (bytes) | 50000 | n/a | yes (`LIMIT_LIKE_PATTERN_LENGTH`) | LIKE/GLOB are O(N^2) on pathological patterns. |
| `SQLITE_MAX_VARIABLE_NUMBER` (highest `?N`) | 32766 (was 999 pre-3.32.0) | n/a | yes (`LIMIT_VARIABLE_NUMBER`) | SQLite allocates slots 1..max-used, so avoid sparse high numbers. |
| `SQLITE_MAX_TRIGGER_DEPTH` | 1000 | n/a | n/a | Only meaningful when `PRAGMA recursive_triggers=ON`. |
| `SQLITE_MAX_ATTACHED` | 10 | 125 | yes (`LIMIT_ATTACHED`) | Each `ATTACH DATABASE`. |
| `SQLITE_MAX_PAGE_COUNT` | 4,294,967,294 (2^32 - 2) | 2^32 - 2 | `PRAGMA max_page_count` | At 64 KiB pages -> ~281 TB. |
| Rows per table | ~2 * 10^13 in practice | 2^64 theoretical | n/a | Disk size bounds first. |
| Page size | 4096 default | 512..65536 (powers of two) | `PRAGMA page_size` before first write | |

Runtime introspection: `sqlite3_limit(db, id, -1)` reads current value; `sqlite3_status()` / `sqlite3_db_status()` report memory & cache stats.

T-SQL implications:
- SQL Server allows up to 1024 cols per table (32 in PK), max row size 8060 bytes for in-row data, max identifier 128 chars, max batch size 65,536 * net packet size. SQLite's defaults are looser everywhere except `JOIN` count (SQLite 64 vs SQL Server 256) and trigger recursion (SQLite 1000 default off; SQL Server 32 nesting + 32 direct recursive when enabled).
- T-SQL `@var` parameters map to SQLite `?N` / `@name`. Do not generate sparse high parameter numbers.
- Reject or chunk T-SQL batches whose generated SQLite SQL would exceed `SQLITE_MAX_SQL_LENGTH`.

## Flexible (Dynamic) Typing

Declared column types are advisory. SQLite uses *type affinity*, not strict type checking. `INSERT INTO t(intcol) VALUES('wxyz')` stores the string `'wxyz'` in an INTEGER-affinity column without error. `VARCHAR(50)` does not truncate; it stores arbitrary-length text.

Exceptions:
- `INTEGER PRIMARY KEY` columns store only 64-bit integers (alias for ROWID).
- `STRICT` tables (CREATE TABLE ... STRICT, 3.37.0+) enforce declared types: only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY`. Use `STRICT` everywhere for MSSQL emulation.

T-SQL implications:
- The server MUST always emit `CREATE TABLE ... STRICT` (and ideally `WITHOUT ROWID` where applicable) to reject mistyped inserts the way SQL Server does.
- Map T-SQL types to STRICT's 5 storage classes; track real declared type in a metadata table (lengths, precision, scale, nullability, collation) and validate at the protocol layer before binding.

### No Native BOOLEAN
Use INTEGER 0/1. `TRUE` / `FALSE` keywords (3.23.0+) are aliases for 1/0 unless a column shadows the name. T-SQL `BIT` -> INTEGER with CHECK (col IN (0,1)).

### No Native DATETIME / DATE / TIME
Store as TEXT (ISO-8601 `'YYYY-MM-DD HH:MM:SS.SSS'`), INTEGER (unix seconds), or REAL (Julian day). Built-in `date()`, `time()`, `datetime()`, `julianday()`, `strftime()`, `unixepoch()` accept all three.

T-SQL `DATETIME` / `DATETIME2` / `DATE` / `TIME` / `DATETIMEOFFSET` / `SMALLDATETIME` need adapter logic:
- Choose TEXT ISO-8601 as canonical to preserve ordering and parsing.
- Implement T-SQL `GETDATE()`, `SYSDATETIME()`, `DATEADD`, `DATEDIFF`, `DATEPART`, `FORMAT` on top of SQLite date functions.
- Timezone: SQLite stores naive UTC by convention; implement DATETIMEOFFSET as TEXT with explicit offset.

### No Fixed-Point DECIMAL/NUMERIC
REAL is IEEE-754 double (about 15-17 decimal digits, with binary rounding errors). SQLite has no native DECIMAL(p,s). Money math is unsafe.

Options:
- Compile/load the `decimal` extension (`ext/misc/decimal.c`) and route DECIMAL/MONEY/NUMERIC through `decimal_add`, `decimal_mul`, etc., storing the value as TEXT.
- Or store as scaled INTEGER (e.g., 4 decimal places = cents*10000).

T-SQL `SUM`, `AVG`, division, and round-trip equality on DECIMAL must use the extension or scaled-INTEGER path; never trust REAL.

## NULL Semantics (SQL Differences Only)

SQLite matches PostgreSQL/Oracle, which mostly matches T-SQL except for one critical UNIQUE difference:

| Behavior | SQLite | SQL Server |
|---|---|---|
| `anything + NULL` | NULL | NULL |
| `NULL * 0` | NULL | NULL |
| `NULL = NULL` | NULL (i.e., not true) | NULL |
| `NULL != NULL` | NULL | NULL |
| `IS NULL` / `IS NOT NULL` | works | works |
| Multiple NULLs in a UNIQUE column | **allowed** (NULLs distinct) | **rejected** (only one NULL allowed) |
| NULL collapsed in `SELECT DISTINCT` | yes (one NULL row) | yes |
| NULL collapsed in `UNION` | yes | yes |
| `CASE WHEN NULL THEN 1 ELSE 0 END` | 0 | 0 |
| `NULL OR TRUE` | TRUE | TRUE |
| `NOT (NULL AND FALSE)` | TRUE | TRUE |

T-SQL implications:
- **UNIQUE columns**: SQL Server allows at most one NULL row; SQLite allows many. Emulate by adding `WHERE col IS NOT NULL` partial unique indexes plus a separate constraint that rejects a second NULL, OR mark the column NOT NULL when possible. There is no exact one-statement equivalent of SQL Server's "UNIQUE with one NULL allowed".
- T-SQL `SET ANSI_NULLS OFF` (legacy) — do not emulate; reject or warn.
- T-SQL `IS [NOT] DISTINCT FROM` -> SQLite `IS [NOT]`.

## Key Quirks for MSSQL Compatibility

### Foreign Keys Off By Default
Run `PRAGMA foreign_keys = ON;` on every connection, or compile with `-DSQLITE_DEFAULT_FOREIGN_KEYS=1`. Otherwise REFERENCES is parsed and silently ignored. T-SQL FKs are always enforced.

### PRIMARY KEY Allows NULLs (Legacy Bug)
A non-INTEGER PRIMARY KEY column may contain NULL (multiple rows, even). Workarounds:
- Always emit `NOT NULL` on every PK column.
- Use `STRICT` and/or `WITHOUT ROWID` tables — these enforce NOT NULL on PK columns correctly.

### INTEGER PRIMARY KEY = ROWID Alias
`INTEGER PRIMARY KEY` (case-insensitive, exact spelling, no `UNSIGNED` etc.) is an alias for the hidden `ROWID`. Inserting NULL allocates the next rowid. This is the closest analog to `IDENTITY`.

Caveats:
- Without `AUTOINCREMENT`, a deleted row's rowid can be reused.
- `INT PRIMARY KEY` is NOT the same — it is a normal INTEGER-affinity column with a uniqueness constraint and is NOT a rowid alias.
- In a `WITHOUT ROWID` table this whole mechanism is disabled.

### AUTOINCREMENT
`AUTOINCREMENT` only legal on `INTEGER PRIMARY KEY`. It changes the allocation algorithm to guarantee monotonically increasing rowids that are never reused; it does NOT enable identity-like features (no seed, no increment, no `IDENTITY_INSERT`, no `SCOPE_IDENTITY()`). It stores state in `sqlite_sequence`.

T-SQL `IDENTITY(seed, increment)`: emulate by
- For `IDENTITY(1,1)`: `INTEGER PRIMARY KEY AUTOINCREMENT`.
- For other seed/increment: use a trigger plus an explicit counter table; do not pretend.
- `SCOPE_IDENTITY()` / `@@IDENTITY` -> `last_insert_rowid()` (per-connection).
- `IDENTITY_INSERT ON` is naturally always-on in SQLite; the server should reject explicit overrides when emulating `IDENTITY_INSERT OFF`.

### REPLACE and ON CONFLICT
SQLite's `INSERT OR REPLACE` / `REPLACE INTO` and the `ON CONFLICT (col) DO UPDATE` (UPSERT, 3.24.0+) are not equivalent to T-SQL `MERGE`. `INSERT OR REPLACE` DELETEs conflicting rows (firing DELETE triggers and cascading FKs) before re-INSERTing. T-SQL `MERGE` performs UPDATEs in place.

T-SQL implications:
- Map `MERGE` to `INSERT ... ON CONFLICT(...) DO UPDATE SET ... WHERE ...`. Do NOT translate to `INSERT OR REPLACE` — it changes semantics (delete-then-insert vs update, plus cascade behavior).
- T-SQL `MERGE` clause matching against `NOT MATCHED BY SOURCE` (DELETE) has no upsert equivalent — implement as a separate `DELETE`.

### Single-Writer Concurrency Model
SQLite is serverless and uses file locks. There can be only one writer at a time across the entire database file. Readers can run concurrently with each other; in WAL mode (`PRAGMA journal_mode=WAL`) readers and a single writer can run concurrently.

T-SQL implications:
- Row-level locking, `WITH (NOLOCK)`, `READPAST`, `UPDLOCK`, `XLOCK`, `SERIALIZABLE` etc. CANNOT be enforced at SQLite level — the engine is effectively SERIALIZABLE for writers and SNAPSHOT-ish in WAL mode for readers.
- Always run in WAL mode (`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL` is the typical tradeoff).
- Use `BEGIN IMMEDIATE` (not plain `BEGIN`) to acquire the write lock up front and avoid `SQLITE_BUSY` mid-transaction.
- Set `PRAGMA busy_timeout = N` (milliseconds) to soften lock contention.
- Long write transactions block all other writers; the server should queue writes or shard.
- No native deadlock detection across processes (busy_timeout only).

### No Stored Procedures
SQLite has VIEWs, TRIGGERs, INDEXes, but no `CREATE PROCEDURE`, no `EXEC`, no procedural language. T-SQL stored procedures, scalar/table-valued functions written in T-SQL, must be:
- Translated to a single (possibly compound) SQL statement, or
- Executed on the protocol/translator side (interpret T-SQL in the server, not in SQLite), or
- Replaced by a user-defined function registered via `sqlite3_create_function` (C/host-language).

### No User / Role / Permission Model
`GRANT` and `REVOKE` are not implemented. The only access control is OS-level file permissions. Authentication, logins, roles, schemas-as-namespaces, `EXECUTE AS`, row-level security must all live in the server layer above SQLite.

### Right/Full Outer Join
Supported since 3.39.0 (2022-06-25). Older versions: only LEFT and INNER. Check `sqlite3_libversion_number()`. Also be aware of the comma-join precedence quirk: `FROM a, b RIGHT JOIN c, d` is parsed left-to-right (wrong per standard); always parenthesize when mixing comma-joins with outer joins.

### GROUP BY Relaxation
Bare (non-aggregate) columns can appear in the SELECT list without being in GROUP BY. SQLite picks one arbitrary row (with one useful exception: with a single `min()` or `max()`, bare columns come from that row). T-SQL is strict — emit an error or rewrite when a T-SQL query would fail under `ONLY_FULL_GROUP_BY`-style rules.

### CAST Behavior
- `CAST('wxyz' AS INTEGER)` -> 0 (T-SQL: error). `CAST('123abc' AS INTEGER)` -> 123 (leading numeric prefix). T-SQL would error.
- `CAST(x AS TEXT)` on REAL produces a SQLite-formatted string that may not match T-SQL's formatting (trailing zeros, scientific notation cutoffs).
- `CAST(NULL AS anything)` -> NULL.
- TRY_CAST / TRY_CONVERT have no direct equivalent; wrap with CASE + `typeof()` or implement in the server.

### Identifier Case Sensitivity
Identifiers are case-insensitive but ONLY for ASCII (`a-z` <-> `A-Z`). Non-ASCII letters are case-sensitive. T-SQL by default is also case-insensitive ASCII; matches well, but Unicode letters in identifiers will diverge.

### String Comparison
Default collation is `BINARY` (byte-by-byte). Built-in: `BINARY`, `NOCASE` (ASCII only), `RTRIM`. T-SQL defaults to a case-insensitive, accent-sensitive collation like `SQL_Latin1_General_CP1_CI_AS`. To emulate:
- Set `COLLATE NOCASE` on TEXT columns, or
- Register a custom collation via `sqlite3_create_collation` that matches the target SQL Server collation.
- `upper()` and `lower()` only handle ASCII unless compiled with ICU (`-DSQLITE_ENABLE_ICU`).

### Double-Quoted String Literals
For MySQL 3.x compatibility, SQLite accepts `"foo"` as a string literal if no matching identifier exists. **DISABLE THIS**:
```c
sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DDL, 0, NULL);
sqlite3_db_config(db, SQLITE_DBCONFIG_DQS_DML, 0, NULL);
```
T-SQL: `"`-quoted is always an identifier (when `QUOTED_IDENTIFIER ON`, which is the modern default). `'...'` is the string literal. Keep DQS off so a typo in a column name fails loudly.

### Keywords Used as Identifiers
SQLite accepts many reserved words as bare identifiers when context is unambiguous (`CREATE TABLE union(true INT, with BOOLEAN);` is valid). T-SQL is stricter. Quote-emit defensively for any identifier the parser cannot prove is safe.

### Reserved Word Mismatches
Words reserved in one engine and not the other (non-exhaustive): T-SQL reserves `TOP`, `IDENTITY`, `OUTPUT`, `MERGE`, `PIVOT`, `UNPIVOT`, `READTEXT`, `BACKUP`, etc., that SQLite does not. SQLite reserves `GLOB`, `MATCH`, `REGEXP`, `VACUUM`, `ATTACH`, `DETACH`, etc., that T-SQL does not. Always quote translated identifiers ([brackets] -> "double quotes" with DQS off).

### Integer vs Text Literal Comparison
`SELECT 1 = '1'` returns 0 (false) in SQLite. Every other major engine including T-SQL returns 1 (true) because of implicit conversion. Compensate by emitting explicit CASTs when translating T-SQL comparisons that mix integer and string types, or rely on column affinity (which usually triggers conversion correctly inside WHERE on a typed column).

### ALTER TABLE Limitations
SQLite supports only:
- `ALTER TABLE ... RENAME TO ...`
- `ALTER TABLE ... RENAME COLUMN ... TO ...`
- `ALTER TABLE ... ADD COLUMN ...` (no NOT NULL without DEFAULT, no PRIMARY KEY, no UNIQUE)
- `ALTER TABLE ... DROP COLUMN ...`

NOT supported:
- Change a column's type, nullability, default, or collation
- Add/drop CHECK, FOREIGN KEY, UNIQUE, PRIMARY KEY constraints
- Reorder columns
- `ALTER COLUMN`, `ADD CONSTRAINT`, `DROP CONSTRAINT`

For anything else: do the "12-step ALTER" (create new table, INSERT SELECT, drop old, rename new, recreate indexes/triggers/views). The server must orchestrate this for T-SQL `ALTER TABLE ALTER COLUMN`, `ADD CONSTRAINT`, etc.

### Triggers
- Only `FOR EACH ROW` (no `FOR EACH STATEMENT`). T-SQL uses statement-level triggers — translate row-by-row, semantics will differ for set-based operations using `inserted`/`deleted` pseudo-tables.
- Triggers see `NEW.col` / `OLD.col` (single row), not `inserted` / `deleted` tables.
- `INSTEAD OF` triggers exist for views only.
- Recursive triggers off by default (`PRAGMA recursive_triggers=ON`).
- Triggers attached to one table cannot directly modify schema and have limited cross-table operations.

### Views Are Read-Only
`INSERT` / `UPDATE` / `DELETE` on a VIEW fails. Use `INSTEAD OF` triggers to emulate updatable views.

### DEFAULT Evaluated at INSERT Time
SQLite defaults are evaluated per-row at INSERT (just like T-SQL). `CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME` work. T-SQL `DEFAULT GETDATE()` -> `DEFAULT CURRENT_TIMESTAMP`. Computed columns: SQLite has `GENERATED ALWAYS AS (expr) [VIRTUAL|STORED]` (3.31.0+).

### NUL Characters Allowed in TEXT
SQLite TEXT may contain ` `. Many client libraries truncate at the first NUL. T-SQL `NVARCHAR` also allows embedded NULs, so behavior is mostly compatible — but TDS / driver layers commonly cut at NUL. Sanitize at the protocol edge.

## Omitted SQL Features

Officially documented as not implemented (compared to standard SQL or other engines):
- `ALTER TABLE` beyond RENAME / ADD / DROP / RENAME COLUMN (see above).
- `FOR EACH STATEMENT` triggers.
- Writable VIEWs (use INSTEAD OF triggers).
- `GRANT` / `REVOKE` / users / roles / schemas.
- No `CREATE PROCEDURE` / `CREATE FUNCTION` in SQL (C-level UDFs only).
- No `CURSOR` (procedural cursors); only the C API step interface.
- No `RAISERROR` / `THROW` (only `RAISE(ABORT|FAIL|IGNORE|ROLLBACK, msg)` inside triggers).
- No `MERGE` statement (use UPSERT).
- No `PIVOT` / `UNPIVOT`.
- No window-function `FILTER` clause prior to 3.30.0 (present since).
- No `OUTPUT` clause; use `RETURNING` (3.35.0+).
- No `WAITFOR DELAY` / `WAITFOR TIME`.
- No native temp tables-with-schema (`#table`, `##table`) — SQLite has `CREATE TEMP TABLE` (per-connection).
- No `TABLE` variables.
- No native synonyms / aliases / linked servers.
- No native full-text search outside FTS3/FTS4/FTS5 virtual tables.
- No `XML` / `JSON` types (JSON is a TEXT subset with JSON1 functions).

## Corruption Risks (Operational)

SQLite is robust but the database file CAN be corrupted by:

1. **Rogue writes to the database file** — another process overwriting the file, or a stale file descriptor being written to after SQLite reopened the underlying fd.
2. **Backups while a transaction is active** — use `VACUUM INTO`, the backup API, or `sqlite3_rsync`; never `cp` a live database without also copying journal/WAL files.
3. **Deleting or mispairing the `*-journal` / `*-wal` files** — they must stay with the database; moving them, swapping between databases, or restoring a DB without its journal causes corruption.
4. **Broken filesystem locks** — NFS and some network filesystems lie about advisory locks; running SQLite on them with multiple writers can corrupt.
5. **POSIX `close()` cancelling advisory locks** — any thread calling `close()` on the database fd (even via `read()`-then-`close()` from an unrelated thread) drops all locks for the process. Don't bypass SQLite to read the file.
6. **Multiple copies of the SQLite library linked into one process** — each copy has its own global lock list; they can step on each other.
7. **Two processes using different VFS / locking protocols** on the same file.
8. **Unlinking / renaming the database while open**, or having multiple hard links and writing through one.
9. **Carrying an open database connection across `fork()`** — child must not use the inherited connection.
10. **`fsync` disabled** — `PRAGMA synchronous=OFF`, or drives/controllers that lie about flush (consumer SSDs, some USB sticks, fake-capacity media). A power loss mid-write then corrupts.
11. **Memory corruption in the application** — stray writes into SQLite's in-memory page cache.
12. **Switching journal modes mid-transaction**, very old historical bugs (alternating writes between 3.6 and 3.7), or known fixed bugs in specific versions.

T-SQL implications:
- Server should run with `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL` or `FULL`, `PRAGMA foreign_keys=ON`, `PRAGMA busy_timeout=<ms>`, `PRAGMA trusted_schema=OFF`.
- Implement T-SQL `BACKUP DATABASE` via `VACUUM INTO` or the C backup API. `RESTORE DATABASE` is a file replace (server must be quiesced).
- Use `PRAGMA integrity_check` (full) or `PRAGMA quick_check` periodically; expose as `DBCC CHECKDB` analog.
- Never expose raw file access; never let two server processes write the same DB file without coordinating.

## Concurrency Model Summary

- **Default (rollback journal)**: writers block readers, readers block writers, only one writer at a time, transactions are SERIALIZABLE.
- **WAL mode**: readers do not block writers, writers do not block readers, still only ONE writer at a time. Readers see a snapshot at transaction start (SNAPSHOT-ish isolation).
- `BEGIN` = `BEGIN DEFERRED` — lock acquired lazily, easy to deadlock-by-upgrade. Prefer `BEGIN IMMEDIATE` for any transaction that will write.
- `BEGIN EXCLUSIVE` blocks all other connections (including readers in rollback mode).
- `PRAGMA busy_timeout=N` makes SQLite spin-wait up to N ms before returning `SQLITE_BUSY`. Set to several seconds in a server.
- No native row-level locks; no native deadlock detection across connections (will return `SQLITE_BUSY` after timeout).
- Map T-SQL `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED | READ COMMITTED | REPEATABLE READ | SERIALIZABLE | SNAPSHOT` to either WAL snapshot reads or full serializable writes; document that hint-based isolation per-statement (`WITH (NOLOCK)`) is silently ignored or rejected.
