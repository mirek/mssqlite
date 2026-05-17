# SQLite PRAGMAs

PRAGMA is SQLite's extension mechanism for tuning the engine and introspecting metadata. Syntax accepts either form: `PRAGMA name;` (getter), `PRAGMA name = value;` or `PRAGMA name(value);` (setter). Booleans accept `1/yes/true/on` or `0/no/false/off`. An optional `schema.` prefix targets `main`, `temp`, or an `ATTACH`ed database. Unknown pragmas are silently ignored (typos do not error). Read-only PRAGMAs are also exposed as table-valued functions named `pragma_<name>(...)`.

**Scope keys used in tables:** `db` = persisted in database file header/pages, `conn` = per-connection (lost on close), `process` = process-global, `build` = compile-time only, `tx` = reset at COMMIT/ROLLBACK.

**Essential pragmas for an MSSQL-compatible server backed by SQLite** (apply on every new connection):

```sql
PRAGMA journal_mode = WAL;          -- concurrent readers + one writer
PRAGMA synchronous  = NORMAL;       -- ACID in WAL; small durability tradeoff
PRAGMA foreign_keys = ON;           -- MSSQL enforces FKs by default
PRAGMA busy_timeout = 5000;         -- avoid SQLITE_BUSY on contention
PRAGMA temp_store   = MEMORY;       -- faster temp tables / sorts
PRAGMA cache_size   = -65536;       -- 64 MiB page cache per conn
PRAGMA mmap_size    = 268435456;    -- 256 MiB mmap (optional)
PRAGMA trusted_schema = OFF;        -- harden schema-defined funcs/vtabs
PRAGMA wal_autocheckpoint = 1000;   -- default; tune for write load
```

Per-transaction (when emulating MSSQL deferred constraint semantics):
```sql
BEGIN;
PRAGMA defer_foreign_keys = ON;     -- auto-reset at COMMIT/ROLLBACK
-- ... statements ...
COMMIT;
```

---

## Concurrency & Durability

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `journal_mode` | `PRAGMA schema.journal_mode = X` | `DELETE`, `TRUNCATE`, `PERSIST`, `MEMORY`, `WAL`, `OFF` | `DELETE` | `db` for WAL (persists across opens); `conn` otherwise | WAL is the only mode supporting concurrent readers + writer. WAL requires SQLite >= 3.7.0 and shared memory (unless `locking_mode=EXCLUSIVE`). `MEMORY`/`OFF` risk corruption on crash. `:memory:` databases are `MEMORY` only. Cannot change while a transaction is active. Returns the new mode (or original if change refused). |
| `synchronous` | `PRAGMA schema.synchronous = X` | `0/OFF`, `1/NORMAL`, `2/FULL`, `3/EXTRA` | `FULL` (rollback), `NORMAL` recommended in WAL | `conn` | `OFF`: no syncs, fastest, OS-crash corruption risk. `NORMAL`: ACID in WAL except durability (last commit may roll back on power loss). `FULL`: fsync on critical writes. `EXTRA`: like FULL plus directory sync after journal unlink (durability across power loss in rollback mode). TEMP schema is always `OFF`. |
| `wal_autocheckpoint` | `PRAGMA wal_autocheckpoint = N` | pages (int); `<=0` disables | 1000 | `conn` (wraps `sqlite3_wal_autocheckpoint()`) | When WAL grows to N pages, a PASSIVE checkpoint runs on next commit. |
| `wal_checkpoint` | `PRAGMA schema.wal_checkpoint(MODE)` | `PASSIVE`, `FULL`, `RESTART`, `TRUNCATE`, `NOOP` | n/a (action) | per-call | Returns 3 cols: `busy` (0/1), `log` (frames in WAL), `checkpointed` (frames moved to DB). `PASSIVE` never blocks. `FULL` waits for writers. `RESTART` waits for readers to release WAL. `TRUNCATE` truncates WAL to 0 bytes. `NOOP` returns stats without checkpointing. |
| `locking_mode` | `PRAGMA schema.locking_mode = X` | `NORMAL`, `EXCLUSIVE` | `NORMAL` | `conn` | `EXCLUSIVE` retains file locks across transactions: fewer syscalls, blocks other processes, and enables WAL without shared memory. `temp` and `:memory:` always `EXCLUSIVE`. WAL+EXCLUSIVE is sticky (cannot revert until leaving WAL). |
| `busy_timeout` | `PRAGMA busy_timeout = ms` | milliseconds | 0 (no wait) | `conn` (wraps `sqlite3_busy_timeout()`) | Sleeps and retries instead of returning `SQLITE_BUSY`. **Essential** for any multi-connection server. |
| `cache_spill` | `PRAGMA cache_spill = bool` or `= N` | bool (all DBs) or N pages (per schema) | ON | `conn` | Allows dirty pages to spill mid-transaction, taking an EXCLUSIVE lock early. Disable for long write transactions that must not block readers until COMMIT. |
| `fullfsync` | `PRAGMA fullfsync = bool` | bool | OFF | `conn` | macOS-only: uses `F_FULLFSYNC` for all syncs. Slower, stronger durability across power loss. |
| `checkpoint_fullfsync` | `PRAGMA checkpoint_fullfsync = bool` | bool | OFF | `conn` | macOS-only: `F_FULLFSYNC` for checkpoint syncs only. Ignored if `fullfsync` is on. |
| `read_uncommitted` | `PRAGMA read_uncommitted = bool` | bool | OFF (SERIALIZABLE) | `conn` | Only meaningful with shared-cache mode (`sqlite3_enable_shared_cache`); otherwise no-op. Avoid for server workloads. |

---

## Foreign Keys, Triggers, Constraints

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `foreign_keys` | `PRAGMA foreign_keys = bool` | bool | OFF (legacy) | `conn` | **Essential**: MUST be enabled per connection for FK enforcement. No-op inside a transaction. Compile-time default may be overridden by `SQLITE_DEFAULT_FOREIGN_KEYS`. Changing invalidates legacy `sqlite3_prepare()` statements (`SQLITE_SCHEMA`). |
| `defer_foreign_keys` | `PRAGMA defer_foreign_keys = bool` | bool | OFF | `conn`, auto-reset at COMMIT/ROLLBACK (`tx`) | Defers ALL FK checks to outer COMMIT for the current transaction. Equivalent to making every FK `DEFERRABLE INITIALLY DEFERRED`. Useful for cyclic inserts/updates. Use `sqlite3_db_status(SQLITE_DBSTATUS_DEFERRED_FKS)` to inspect pending violations. |
| `ignore_check_constraints` | `PRAGMA ignore_check_constraints = bool` | bool | OFF (CHECK enforced) | `conn` | Disables CHECK constraint enforcement. |
| `recursive_triggers` | `PRAGMA recursive_triggers = bool` | bool | OFF (legacy) | `conn` | Enables triggers firing other triggers. Bounded by `SQLITE_MAX_TRIGGER_DEPTH` (compile) and `SQLITE_LIMIT_TRIGGER_DEPTH` (runtime). Changing may invalidate legacy prepared statements. |
| `trusted_schema` | `PRAGMA trusted_schema = bool` | bool | ON (legacy) | `conn` | When OFF, blocks unaudited SQL functions / vtabs from running inside schema contexts (CHECK, DEFAULT, generated columns, expression/partial indexes, views, triggers). **Recommended OFF** for any server accepting external schemas. Compile default flippable via `-DSQLITE_TRUSTED_SCHEMA=0`. |
| `foreign_key_list` | `PRAGMA foreign_key_list(table)` | n/a | n/a | read | One row per FK constraint; columns `id, seq, table, from, to, on_update, on_delete, match`. |
| `foreign_key_check` | `PRAGMA schema.foreign_key_check;` or `(table)` | n/a | n/a | read | Returns rows for each FK violation: `(child_table, rowid, parent_table, fk_id)`. |

---

## Memory & Caching

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `cache_size` | `PRAGMA schema.cache_size = N` | `N>0` pages; `N<0` is `abs(N) * 1024` bytes | -2000 (≈2 MiB) | `conn` (reverts when DB closed) | Suggested upper bound. Negative values track current page size. TEMP defaults to 0. |
| `page_size` | `PRAGMA schema.page_size = N` | power-of-two 512..65536 | 4096 (since 3.12.0) | `db` (header); applied at create or next VACUUM (not in WAL) | Cannot be changed in WAL mode. Larger pages favor large rows / fewer seeks. |
| `mmap_size` | `PRAGMA schema.mmap_size = N` | bytes; 0 disables; <0 reverts | 0 or `SQLITE_DEFAULT_MMAP_SIZE` | `conn`; defaults propagate to subsequent ATTACH | Capped by `SQLITE_MAX_MMAP_SIZE` (build) and `SQLITE_CONFIG_MMAP_SIZE` (startup). Cannot shrink while in use. |
| `temp_store` | `PRAGMA temp_store = X` | `0/DEFAULT`, `1/FILE`, `2/MEMORY` | per `SQLITE_TEMP_STORE` (usually FILE) | `conn`; changing drops all temp objects | Build value can force-override pragma (see truth table in docs). |
| `temp_store_directory` (deprecated) | `PRAGMA temp_store_directory = 'path'` | path string | OS-dependent | `process` (not threadsafe) | Deprecated; prefer `sqlite3_temp_directory` set before connections open. |
| `data_store_directory` (deprecated) | same | path | OS-dependent | `process` (WinRT) | Deprecated. |
| `soft_heap_limit` | `PRAGMA soft_heap_limit = N` | bytes; 0 disables | 0 | `process` (wraps `sqlite3_soft_heap_limit64`) | Best-effort cap on heap; SQLite tries to free memory above it. |
| `hard_heap_limit` | `PRAGMA hard_heap_limit = N` | bytes; can only lower | 0 | `process` (wraps `sqlite3_hard_heap_limit64`) | Hard cap: allocations beyond fail. Pragma cannot raise; use C API to raise. |
| `threads` | `PRAGMA threads = N` | worker threads | 0 (`SQLITE_DEFAULT_WORKER_THREADS`) | `conn` (wraps `sqlite3_limit(SQLITE_LIMIT_WORKER_THREADS)`) | Max auxiliary threads per prepared statement (e.g. for parallel sort). |
| `shrink_memory` | `PRAGMA shrink_memory` | n/a (action) | n/a | `conn` (wraps `sqlite3_db_release_memory`) | Releases as much heap as possible. |

---

## Schema & Introspection

| Pragma | Form | Returns / Effect | Scope |
|---|---|---|---|
| `schema_version` | get/set `PRAGMA schema.schema_version[=N]` | Header offset 40; auto-incremented on every schema change. Setting it is dangerous and a no-op under defensive mode. | `db` |
| `user_version` | get/set `PRAGMA schema.user_version[=N]` | Free-for-application integer at header offset 60. | `db` |
| `application_id` | get/set `PRAGMA schema.application_id[=N]` | 32-bit signed app magic at header offset 68 (for `file(1)`). | `db` |
| `database_list` | `PRAGMA database_list` | One row per ATTACH: `(seq, name, file)`. | read |
| `table_list` | `PRAGMA table_list[(name)]` | One row per table/view across schemas: `(schema, name, type, ncol, wr, strict)` (3.37.0+). | read |
| `table_info` | `PRAGMA schema.table_info(table)` | `(cid, name, type, notnull, dflt_value, pk)`. Excludes generated/hidden. | read |
| `table_xinfo` | `PRAGMA schema.table_xinfo(table)` | Same as `table_info` plus `hidden` column (0=normal, 1=virtual-hidden, 2=virtual generated, 3=stored generated). | read |
| `index_list` | `PRAGMA schema.index_list(table)` | `(seq, name, unique, origin {c|u|pk}, partial)`. | read |
| `index_info` | `PRAGMA schema.index_info(idx)` | Key columns only: `(seqno, cid, name)`. For WITHOUT ROWID tables, returns dedup'd PK columns. | read |
| `index_xinfo` | `PRAGMA schema.index_xinfo(idx)` | All columns incl. auxiliary: `(seqno, cid, name, desc, coll, key)`. | read |
| `foreign_key_list` | `PRAGMA foreign_key_list(table)` | See FK section. | read |
| `foreign_key_check` | `PRAGMA schema.foreign_key_check[(table)]` | See FK section. | read |
| `integrity_check` | `PRAGMA schema.integrity_check[(N\|table)]` | Deep structural check; returns `'ok'` or up to N errors (default 100). O(N log N). Skips FK errors (use `foreign_key_check`). | read |
| `quick_check` | `PRAGMA schema.quick_check[(N\|table)]` | Like `integrity_check` minus UNIQUE & index-content checks. O(N). | read |
| `encoding` | get; set only before main DB created | `'UTF-8'`, `'UTF-16le'`, `'UTF-16be'` (`'UTF-16'` => native). Immutable once set. ATTACHed DBs must match. | `db` |
| `function_list` | `PRAGMA function_list` | All registered SQL functions; one row per `(name, builtin, type, enc, narg, flags)`. | read |
| `module_list` | `PRAGMA module_list` | Registered virtual-table modules. | read |
| `pragma_list` | `PRAGMA pragma_list` | All known pragma names for this build. | read |
| `collation_list` | `PRAGMA collation_list` | Registered collations: `(seq, name)`. | read |

---

## Query Planner / Optimizer

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `optimize` | `PRAGMA optimize[(MASK)]` or `schema.optimize` | bitmask: `0x00002` ANALYZE-if-needed (on), `0x00010` bound analyze run-time (on), `0x10000` re-analyze grown/shrunk tables (off), `0x00001` dry-run (off); default `0xfffe` | n/a | per-call | Recommended: run once at close for short-lived conns; run `PRAGMA optimize=0x10002` at open and periodically for long-lived. Auto-sets temporary `analysis_limit`. |
| `analysis_limit` | `PRAGMA analysis_limit = N` | approx rows scanned per index by ANALYZE; 0 = unlimited | 0 | `conn` | Caps ANALYZE work on huge tables. 100–1000 typical. Since 3.46.0 prefer `PRAGMA optimize`. |
| `automatic_index` | `PRAGMA automatic_index = bool` | bool | ON (since 3.7.17) | `conn` | Enables transient indexes for ad-hoc joins. |
| `query_only` | `PRAGMA query_only = bool` | bool | OFF | `conn` | Read-only enforcement: writes return `SQLITE_READONLY`; checkpoint/COMMIT still allowed. Does not affect `sqlite3_db_readonly()`. |
| `reverse_unordered_selects` | `PRAGMA reverse_unordered_selects = bool` | bool | OFF | `conn` | Reverses output order for SELECTs without ORDER BY. Test/debugging aid. |
| `case_sensitive_like` (deprecated) | `PRAGMA case_sensitive_like = bool` | bool | OFF | `conn` | Overrides LIKE/GLOB UDFs. Can corrupt indexes/CHECKs that reference LIKE. **Avoid.** |
| `stats` (testing) | `PRAGMA stats` | undocumented internal stats | n/a | read | Internal SQLite testing pragma — format unstable. Do not use in apps. |

---

## Debug / Safety / Hardening

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `cell_size_check` | `PRAGMA cell_size_check = bool` | bool | OFF | `conn` | Extra b-tree page sanity checks on read; mild perf cost, contains corruption earlier. |
| `writable_schema` | `PRAGMA writable_schema = bool` or `RESET` | bool or `RESET` | OFF | `conn` | When ON (and defensive OFF), allows raw UPDATE/INSERT/DELETE on `sqlite_schema`. `RESET` turns it off AND reloads schema. **Dangerous — can corrupt DB.** |
| `secure_delete` | `PRAGMA schema.secure_delete = bool\|FAST` | `0/1/FAST` | per `SQLITE_SECURE_DELETE` (usually OFF) | `db` (persisted for some modes); applies to attached DBs at ATTACH time | ON overwrites deleted content with zeros (more I/O). `FAST` zeros only when free (b-tree only, not freelist). FTS shadow tables not scrubbed. |
| `defensive` | *No PRAGMA in stock build* — use `sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL)` | n/a | OFF | `conn` | Disables ability to corrupt DB via SQL: forbids `journal_mode=OFF`, no-ops `schema_version` writes, blocks `writable_schema`, etc. **Recommended ON** for servers. |
| `legacy_alter_table` | `PRAGMA legacy_alter_table = bool` | bool | OFF | `conn` (also `SQLITE_DBCONFIG_LEGACY_ALTER_TABLE`) | Makes `ALTER TABLE ... RENAME` only rewrite top-level CREATE TABLE/INDEX/TRIGGER references (3.24.0- behavior). Temporarily forced ON during vtab `xRename`. |
| `legacy_file_format` | n/a | n/a | n/a | no-op | Removed; use `SQLITE_DBCONFIG_LEGACY_FILE_FORMAT` via `sqlite3_db_config`. |
| `parser_trace` `vdbe_trace` `vdbe_listing` `vdbe_addoptrace` `vdbe_debug` | bool | bool | OFF | `conn` (build: requires `SQLITE_DEBUG`) | SQLite-internal debug tracing; not in normal builds. |

---

## Compile/Runtime Introspection

| Pragma | Form | Returns | Scope |
|---|---|---|---|
| `compile_options` | `PRAGMA compile_options` | One row per compile-time option used (without `SQLITE_` prefix). Matches `sqlite_compileoption_get()`. | read / `build` |
| `data_version` | `PRAGMA schema.data_version` | Integer that increments when **another** connection commits to this DB. Same connection's own commits do NOT change it. Useful for cache invalidation. | per-`conn` view of `db` |
| `freelist_count` | `PRAGMA schema.freelist_count` | Number of unused (freelist) pages. | read |
| `page_count` | `PRAGMA schema.page_count` | Total pages allocated in DB file. | read |
| `max_page_count` | `PRAGMA schema.max_page_count[=N]` | Cap on pages; cannot be set below current `page_count`. Returns current cap. | `db` |

---

## Vacuum / File Maintenance

| Pragma | Setter | Values | Default | Scope | Notes |
|---|---|---|---|---|---|
| `auto_vacuum` | `PRAGMA schema.auto_vacuum = X` | `0/NONE`, `1/FULL`, `2/INCREMENTAL` | NONE (or `SQLITE_DEFAULT_AUTOVACUUM`) | `db` (header bit) | Must be set BEFORE any table is created, OR followed by `VACUUM` to take effect. Moving from FULL/INCREMENTAL back to NONE always requires `VACUUM`. FULL truncates freelist each commit; INCREMENTAL only via `incremental_vacuum`. |
| `incremental_vacuum` | `PRAGMA schema.incremental_vacuum[(N)]` | N pages to free; omit = all | n/a | per-call | No-op unless `auto_vacuum=INCREMENTAL`. Truncates DB file. |
| `journal_size_limit` | `PRAGMA schema.journal_size_limit = N` | bytes; `-1` no limit; `0` always truncate | -1 (or `SQLITE_DEFAULT_JOURNAL_SIZE_LIMIT`) | `conn` per schema | Caps size of rollback journal / WAL file left on disk between transactions. |

---

## Deprecated / Legacy (do not use in new code)

`case_sensitive_like`, `count_changes`, `data_store_directory`, `default_cache_size`, `empty_result_callbacks`, `full_column_names`, `short_column_names`, `temp_store_directory`, `legacy_file_format` (now a no-op). May be omitted under `-DSQLITE_OMIT_DEPRECATED`.

---

## Notes for an MSSQL-Compatible Server

1. **Connection bootstrap order matters.** Set `journal_mode=WAL` first (database-wide, persisted), then per-connection settings: `foreign_keys`, `busy_timeout`, `synchronous`, `cache_size`, `temp_store`, `trusted_schema`.
2. **`foreign_keys` is per-connection** — must be set on every new connection or pool checkout. MSSQL semantics expect FK enforcement; setting `SQLITE_DEFAULT_FOREIGN_KEYS=1` at build time is a defense in depth.
3. **Defer FK checks per transaction** to emulate MSSQL's deferred constraint timing: issue `PRAGMA defer_foreign_keys=ON` immediately after `BEGIN` — it auto-resets on COMMIT/ROLLBACK.
4. **WAL + busy_timeout is the only viable concurrency story** for a server: multiple readers do not block one writer, and `busy_timeout` converts `SQLITE_BUSY` into bounded waits. Consider `wal_autocheckpoint` tuning (default 1000 pages ≈ 4 MiB) and periodic `PRAGMA wal_checkpoint(TRUNCATE)` during quiet windows.
5. **`synchronous=NORMAL`** is the canonical WAL setting: full ACID minus power-loss durability of the last commit. Use `FULL` (or `EXTRA` in rollback mode) if durability is non-negotiable.
6. **Harden the connection:** `trusted_schema=OFF`, defensive mode ON (via `sqlite3_db_config`), `cell_size_check=ON` if you accept untrusted DB files. Never expose `writable_schema` or `schema_version=` to clients.
7. **Introspection mapping** for MSSQL `INFORMATION_SCHEMA`/`sys` views: build views over `pragma_table_list`, `pragma_table_xinfo`, `pragma_index_list`, `pragma_index_xinfo`, `pragma_foreign_key_list`, `pragma_function_list`. The table-valued-function form (since 3.16.0) lets you JOIN them with `sqlite_schema`.
8. **`data_version`** is the cheap polling primitive for "did another connection change this DB since I last looked?" — useful for plan-cache or metadata invalidation in the server.
9. **`page_size` and `auto_vacuum`** are header-persisted but only take effect before any table exists (or after a `VACUUM`). Choose at DB creation time.
10. **`encoding`** is permanent after creation. Pick `UTF-8` (matches MSSQL `NVARCHAR` after server-side conversion); ATTACH refuses mismatched encodings.
