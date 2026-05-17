# Transactions, Locking & Concurrency

This chapter describes SQLite's transaction model, locking, isolation, and concurrency primitives. These details are critical for designing an MSSQL-compatible server backed by SQLite: SQLite has a single-writer model, snapshot isolation (WAL) or serializable (rollback), and exposes `SQLITE_BUSY` rather than blocking on lock waits unless `busy_timeout` is set.

## Autocommit & Implicit Transactions

Every statement runs inside a transaction. If no `BEGIN` is active, SQLite is in **autocommit mode**: each statement implicitly starts and commits its own transaction. The implicit transaction is committed when the statement "finishes" — for prepared statements, that means `sqlite3_reset()` or `sqlite3_finalize()` (or close of an open `sqlite3_blob`). Long-running statements that have not been reset still hold their transaction.

Use `sqlite3_get_autocommit()` / `sqlite3_txn_state()` to inspect connection state.

For an MSSQL emulator: SQL Server's "implicit transactions" (`SET IMPLICIT_TRANSACTIONS ON`) and explicit `BEGIN TRAN` both need to map onto SQLite's `BEGIN ... COMMIT`. T-SQL `BEGIN TRAN` without `IMMEDIATE` maps naturally onto `BEGIN DEFERRED`, but see below — `IMMEDIATE` is almost always what a server wants.

## BEGIN \[DEFERRED | IMMEDIATE | EXCLUSIVE\] TRANSACTION

```sql
BEGIN;                         -- same as BEGIN DEFERRED
BEGIN DEFERRED TRANSACTION;
BEGIN IMMEDIATE TRANSACTION;
BEGIN EXCLUSIVE TRANSACTION;
```

- **DEFERRED** (default): no lock is taken at `BEGIN`. The transaction starts on the first statement. A `SELECT` starts a read transaction; a write statement (`INSERT/UPDATE/DELETE/CREATE/DROP`) starts a write transaction. A read transaction can be upgraded to a write transaction on the first write — but if another connection has already moved the database past your read snapshot, the upgrade fails with `SQLITE_BUSY_SNAPSHOT`. In WAL mode this is the common deadlock-equivalent.
- **IMMEDIATE**: acquires the write lock right away. Returns `SQLITE_BUSY` if another writer is active. Once it succeeds, no subsequent statement in the transaction will fail with `SQLITE_BUSY` due to a competing writer. **This is the right default for a server emulating MSSQL**: it avoids snapshot-upgrade failures and matches SQL Server's "writer takes a write lock" mental model.
- **EXCLUSIVE**: same as `IMMEDIATE` in WAL mode. In rollback-journal mode, also prevents other connections from *reading* the database for the duration of the transaction. Rarely needed.

Transactions started by `BEGIN` persist until `COMMIT` / `ROLLBACK` (or an error triggering rollback). `BEGIN` inside an active transaction is an error — SQLite does not nest `BEGIN ... COMMIT`. Use `SAVEPOINT` for nesting.

## COMMIT / END / ROLLBACK

```sql
COMMIT;          -- write transaction is finalized
END;             -- alias for COMMIT
END TRANSACTION;
ROLLBACK;        -- discards all changes since BEGIN
```

`COMMIT` may itself return `SQLITE_BUSY` if a pending read or write blocks finalization (e.g. a still-open read cursor on the same connection). On `SQLITE_BUSY`, the transaction remains open; retry.

`ROLLBACK` in modern SQLite (>= 3.8.8) does not require pending reads to be closed and will let unrelated pending reads continue, *unless* the rollback changes schema. Old pre-3.7.11 SQLite would return `SQLITE_BUSY` on `ROLLBACK` with pending queries — assume modern.

Note: `PRAGMA journal_mode = OFF` makes `ROLLBACK` undefined. Never use `journal_mode=OFF` for a server.

## SAVEPOINT / RELEASE / ROLLBACK TO

```sql
SAVEPOINT sp1;
  -- work ...
  SAVEPOINT sp2;
    -- more work ...
  ROLLBACK TO sp2;   -- undo work since sp2; sp2 still on stack
  RELEASE sp2;       -- merges sp2 into sp1
RELEASE sp1;         -- if outermost, commits; otherwise merges into parent
```

Semantics:

- `SAVEPOINT name` pushes a named mark onto the transaction stack. Names need not be unique; `RELEASE`/`ROLLBACK TO` matches the *most recent* matching name.
- If a `SAVEPOINT` is issued outside `BEGIN`, the outermost savepoint behaves like `BEGIN DEFERRED`. To get IMMEDIATE-style semantics with savepoints, do `BEGIN IMMEDIATE; SAVEPOINT sp1; ...`.
- `ROLLBACK TO name` undoes work back to the savepoint, **but does not pop the savepoint**. The transaction continues; the named savepoint remains on the stack. Intervening savepoints are discarded.
- `RELEASE name` pops the named savepoint and everything above it. **No data is flushed to disk** — release merges the changes into the parent. If `RELEASE` empties the stack, it behaves like `COMMIT`.
- A `ROLLBACK` (no `TO`) discards the entire transaction, regardless of savepoint depth.
- A `COMMIT` discards all savepoints and commits the whole thing.

Critical for an MSSQL emulator: T-SQL `SAVE TRANSACTION name` / `ROLLBACK TRANSACTION name` map cleanly onto `SAVEPOINT` / `ROLLBACK TO`. Note T-SQL has no exact equivalent of `RELEASE` — SQL Server savepoints simply disappear when the outer transaction commits. Emulate by issuing an explicit `RELEASE` at the right time, or omit it (savepoints will be cleared by the eventual `COMMIT`).

Also critical: **inner-savepoint "commits" can still be undone**. If an outer transaction rolls back (or a crash happens before the outermost commit), all the released inner savepoints go with it. Nothing reaches disk until the outermost transaction commits.

## Isolation Model

SQLite isolation depends on `journal_mode`:

- **Rollback-journal mode** (`DELETE` / `TRUNCATE` / `PERSIST`): truly serializable. Writers exclusively lock the database file during the commit phase; readers are evicted briefly. Readers cannot see uncommitted data.
- **WAL mode**: **snapshot isolation** per connection. A read transaction sees a fixed snapshot ("end mark" in the WAL) as it existed at the time the read transaction began. Concurrent commits by other connections do not invalidate the snapshot — but the reader will not see them either.

Both modes are at least serializable in the formal sense (a single writer, plus reads against a frozen snapshot). The one exception is **shared cache + `PRAGMA read_uncommitted = 1`**, which is the only way one connection can see another connection's uncommitted data. Avoid this for a server.

**Same-connection isolation**: there is *no* isolation within a single connection. Statements on connection X see X's own uncommitted writes. A long-running `SELECT` on X concurrent with `UPDATE` on X may or may not see those updates — the behavior is undefined. Server design rule: do not issue writes against a connection while a `SELECT` cursor on that same connection is mid-iteration.

Summary rules:

1. Transactions are serializable (or snapshot in WAL).
2. Changes are invisible to other connections before commit.
3. A query sees all changes already completed on its own connection.
4. Behavior is undefined for changes that occur on the same connection while a query is stepping.

## Locking States (Rollback-Journal Mode)

Each open database file goes through five locking states. The pager only tracks four (PENDING is transient).

| State | Meaning |
|---|---|
| **UNLOCKED** | No lock. Cache is suspect. Default. |
| **SHARED** | Read allowed. Many SHARED locks can coexist. No writer can write while any SHARED exists. |
| **RESERVED** | "I intend to write." At most one RESERVED at a time. Coexists with active SHARED locks (readers continue). New SHARED locks can still be acquired. |
| **PENDING** | "I want EXCLUSIVE; no new readers, please." Existing SHARED locks may continue; no new SHARED locks granted. Stepping stone to EXCLUSIVE. Prevents writer starvation. |
| **EXCLUSIVE** | Required to write to the database file. No other lock of any kind coexists. Held only as briefly as possible during commit. |

Read path: `UNLOCKED -> SHARED -> read -> UNLOCKED`.

Write path: `UNLOCKED -> SHARED -> RESERVED -> (build journal in memory and on disk) -> PENDING -> EXCLUSIVE -> write data pages -> fsync -> delete journal (commit point) -> UNLOCKED`.

If another writer already holds `RESERVED`, attempts to acquire `RESERVED` return `SQLITE_BUSY` immediately.

The journal file (`<db>-journal`) holds the original page images. A "hot journal" — a journal whose process died before deleting it — is detected and rolled back by the next reader/writer.

In **WAL mode**, this lock state machine is largely bypassed. WAL uses shared memory (`<db>-shm` wal-index) and byte-range locks on the WAL file to coordinate. The classic five-state model still describes the database file itself but transitions are very short and EXCLUSIVE is essentially only used during WAL recovery / checkpoint reset.

## WAL Mode

Enable once per database (the setting persists in the file header):

```sql
PRAGMA journal_mode = WAL;     -- returns 'wal' on success
```

WAL inverts rollback semantics: the database file stays unchanged; new pages are appended to the `-wal` file. A commit is the appending of a commit record to the WAL.

### Files

- `<db>` — the main database file (only modified by checkpoint or vacuum).
- `<db>-wal` — append-only write-ahead log. Contains frames of modified pages plus commit markers.
- `<db>-shm` — shared-memory wal-index. mmapped file used as IPC between processes/threads to locate WAL frames quickly.

The `-wal` and `-shm` files are part of the database state. If you copy the database, you must copy them too (or first checkpoint+close). The safe way to detach the WAL is to open the database and immediately close it cleanly.

WAL does **not** work over network filesystems (it relies on shared memory between processes).

### Concurrency model

- **Readers do not block writers.** Each reader records an "end mark" — the last commit record in the WAL at the time the reader's transaction began. Reads consult the wal-index to fetch the most recent version of each page *up to that end mark*; if no WAL frame exists for a page, the read falls through to the main database file.
- **Writers do not block readers.** A writer appends frames at the end of the WAL. Existing readers see their old snapshot; new readers see committed writes.
- **One writer at a time.** Only one connection may hold the WAL "writer" lock. Other writers get `SQLITE_BUSY`.
- A long-running write transaction blocks other writers (they get `SQLITE_BUSY` on `BEGIN IMMEDIATE` or on first write of a `DEFERRED` transaction).
- A long-running read transaction does *not* block writers, but it does block **checkpointing** past the reader's end mark.

### Snapshot upgrade failure

If a `DEFERRED` transaction starts as a read transaction, another connection commits writes, and then your transaction tries to write, the upgrade fails with `SQLITE_BUSY_SNAPSHOT`. You must `ROLLBACK` and start a new transaction. **`BEGIN IMMEDIATE` avoids this entirely** by acquiring the writer lock at the start.

### Checkpointing

Moving WAL frames back into the main database file is called a checkpoint. The default is automatic checkpointing whenever a commit grows the WAL to >= 1000 pages (~4 MiB at the default 4 KiB page size).

```sql
PRAGMA wal_autocheckpoint = 1000;        -- 0 disables auto-checkpointing
PRAGMA wal_checkpoint(PASSIVE);          -- default; never blocks anyone
PRAGMA wal_checkpoint(FULL);             -- waits for writers, then runs
PRAGMA wal_checkpoint(RESTART);          -- like FULL, then forces next writer to restart WAL from byte 0
PRAGMA wal_checkpoint(TRUNCATE);         -- like RESTART, then truncates -wal to zero bytes
```

Modes:

- **PASSIVE** — copies as many frames as it can without blocking. Stops when it hits a reader's end mark. Returns even if work remains. This is what `wal_autocheckpoint` and `sqlite3_wal_checkpoint()` (v1) run.
- **FULL** — blocks new writers, waits for the current writer to finish, then checkpoints everything to that point. Still stops at concurrent reader end marks.
- **RESTART** — same as FULL, then waits until all existing readers finish so the next writer rewinds the WAL to the start. Readers may block briefly.
- **TRUNCATE** — same as RESTART, plus shrinks the `-wal` file to zero length.

**Checkpoint starvation**: if there is always at least one overlapping read transaction, PASSIVE checkpoints can never reset the WAL — it grows without bound. A server should ensure occasional reader gaps and consider periodic `wal_checkpoint(TRUNCATE)` during idle windows.

### When SQLITE_BUSY can still happen in WAL mode

Despite "readers don't block writers", you can get `SQLITE_BUSY`:

1. Another connection holds the database in `PRAGMA locking_mode=EXCLUSIVE` — every query against the DB will return `SQLITE_BUSY`.
2. The last connection closing is doing its final cleanup checkpoint (briefly takes an exclusive lock).
3. The previous owner crashed and a new connection is running WAL recovery (exclusive lock for the duration).
4. Two writers race — only one wins, the other gets `SQLITE_BUSY`.
5. `SQLITE_BUSY_SNAPSHOT` on a `DEFERRED` upgrade as described above.

## busy_timeout and the Busy Handler

By default, lock contention returns `SQLITE_BUSY` immediately. Install a busy handler to wait:

```sql
PRAGMA busy_timeout = 5000;   -- milliseconds; sets default handler
```

Equivalent C API: `sqlite3_busy_timeout(db, ms)` or `sqlite3_busy_handler(db, fn, arg)` for custom backoff. The handler sleeps and retries until the lock is acquired or the timeout elapses.

Recommended for a server: set `PRAGMA busy_timeout` to several seconds on every connection. Otherwise concurrent clients will frequently see spurious `SQLITE_BUSY`. Still be prepared to surface `SQLITE_BUSY` to clients on timeout — it maps reasonably to a SQL Server lock timeout or deadlock victim error.

Note: the busy handler is **not** invoked for `SQLITE_BUSY_SNAPSHOT` (snapshot upgrade failure) — that one always surfaces immediately. Use `BEGIN IMMEDIATE` to avoid it.

## Deferred Foreign Keys

Foreign key constraint checking happens by default at the statement level. SQLite supports both `DEFERRABLE INITIALLY DEFERRED` per-constraint and a connection-wide pragma:

```sql
-- Per constraint (declared at table creation):
CREATE TABLE child (
  parent_id INTEGER,
  FOREIGN KEY(parent_id) REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED
);

-- For the next transaction only:
PRAGMA defer_foreign_keys = ON;
```

Deferred FKs are checked at `COMMIT` instead of after each statement. A failed deferred check causes `COMMIT` to fail and the transaction rolls back (or, if you have savepoints, you can `ROLLBACK TO` and try again before commit). `PRAGMA defer_foreign_keys` automatically resets to OFF at the end of each transaction.

`PRAGMA foreign_keys = ON` must be enabled at the connection level for FK enforcement at all — it is **off by default** in SQLite. Set it on every connection in the server.

## Triggers and FKs Inside Transactions

Triggers fire as part of the statement that triggered them and participate in the surrounding transaction. A trigger's effects are rolled back with the outer transaction or savepoint. Triggers cannot start or commit their own transactions; you cannot run `BEGIN`/`COMMIT`/`SAVEPOINT` from inside a trigger.

Foreign key cascade actions (`ON DELETE CASCADE`, etc.) execute within the same statement that triggered them, and similarly roll back with the transaction.

## read_uncommitted (Shared-Cache Only)

```sql
PRAGMA read_uncommitted = 1;
```

Only meaningful when two connections share a cache (shared-cache mode). Then the reader can see another shared-cache connection's uncommitted writes. **Outside shared cache, this pragma is a no-op.** For a server, leave it off.

## Shared Cache Mode

Shared cache is an old feature (2006) intended for memory-constrained embedded systems. The SQLite team officially **discourages its use** — WAL mode supersedes its concurrency benefits.

If forced to use it (don't), the locking model changes:

- Connections sharing a cache use **table-level read/write locks**, not file-level locks, and surface `SQLITE_LOCKED` instead of `SQLITE_BUSY`.
- At most one connection in a shared cache may hold a write transaction at a time.
- `PRAGMA read_uncommitted` becomes meaningful.
- Connection isolation for the purposes of the rules in *Isolation Model* above degrades: shared-cache connections with `read_uncommitted` count as the *same* connection.

For an MSSQL-compatible server: **always use private caches, WAL mode, one connection per concurrent worker/session**. Don't enable shared cache.

## Atomic Commit & Power-Failure Safety (Brief)

SQLite guarantees that a transaction either fully commits or has no effect, even across program crash, OS crash, or power loss. This is achieved in rollback mode by:

1. Writing original page images into `<db>-journal` and fsyncing it.
2. Acquiring EXCLUSIVE lock.
3. Writing the modified pages to the main database.
4. fsyncing the main database.
5. Deleting (or truncating) the journal — this delete is the **commit point**.

A crash before step 5 leaves a "hot journal"; the next opener detects it and rolls back. In WAL mode, the commit point is the fsync of the WAL containing the commit-record frame; on crash, frames past the last valid commit record are ignored on recovery.

`PRAGMA synchronous` controls durability vs. speed:

- `FULL` (default in rollback mode): fsync at every commit. Safe across power loss.
- `NORMAL` (default in WAL): fsync less aggressively. WAL frames may be lost on power loss, but the database file cannot be corrupted. Acceptable for many server workloads.
- `OFF`: no fsync. The OS may lose recent commits and may also corrupt the database. Do not use.

Server recommendation: `synchronous = NORMAL` with WAL mode for the throughput/durability sweet spot; use `FULL` if you need strict durability guarantees per-commit.

## Server-Design Recommendations (Summary)

For an MSSQL-compatible server emulating SQL Server semantics:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA wal_autocheckpoint = 1000;
```

- One SQLite `sqlite3*` connection per server session/worker; never share connections between concurrent statements.
- Map T-SQL `BEGIN TRAN` to `BEGIN IMMEDIATE` if the session is known to write (the common case) — avoids `SQLITE_BUSY_SNAPSHOT`.
- Map `SAVE TRANSACTION name` to `SAVEPOINT name`, `ROLLBACK TRANSACTION name` to `ROLLBACK TO name`. Issue `RELEASE` at the right time (or rely on the outer commit).
- Surface `SQLITE_BUSY` after timeout as a lock-timeout error to the client. Surface `SQLITE_BUSY_SNAPSHOT` similarly (or transparently retry the whole transaction).
- Run an idle-window `wal_checkpoint(TRUNCATE)` (e.g. nightly or by file-size threshold) to keep the `-wal` bounded.
- Never enable shared cache or `read_uncommitted`.
- Treat any non-`SQLITE_OK` error from `COMMIT` as transaction-still-open (and possibly retryable for `SQLITE_BUSY`); on unrecoverable errors issue an explicit `ROLLBACK`.
