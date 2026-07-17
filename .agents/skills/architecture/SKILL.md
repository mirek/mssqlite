---
name: architecture
description: "mssqlite system architecture: package dependency graph, request lifecycle from TDS packet to SQLite and back, key design decisions (name flattening, NOCASE collation, parameter passthrough, UDF strategy, session model, metadata inference) and current limitations. Use when deciding where a change belongs, extending T-SQL/protocol coverage, or debugging cross-layer behavior."
---

# mssqlite Architecture

MSSQL compatible, SQLite backed, SQL Server. Two independent towers meet in
the engine:

```
        wire                          language
  @mssqlite/bytes               @mssqlite/tsql (lex/parse → AST)
        │                             │
  @mssqlite/tds                 @mssqlite/transpile (AST → SQLite SQL)
        │                             │
        │                       @mssqlite/catalog (sys.* emulation)
        │                             │
        └──── @mssqlite/server ── @mssqlite/engine ── node:sqlite
```

## Request lifecycle

1. **Socket bytes → messages** — cleartext PRELOGIN first negotiates
   encryption. During a TDS 7.4 TLS handshake, `server/tls-transport.ts`
   bridges Node's `TLSSocket` records through PRELOGIN packet wrappers; after
   the final wrapped server record drains, both directions switch to raw TLS
   carrying ordinary TDS packets. `Tds.Message.push` then reassembles packets
   (pure incremental state) into `{ type, payload }` messages.
2. **Dispatch by packet type** (`server/connection.ts`) — prelogin,
   login7, SQL batch, RPC, transaction manager, attention.
3. **SQL batch** — `engine.executeBatch(session, sql)`:
   - `tsql.parse` → `Ast.Statement[]`
   - per statement: directly renderable (SELECT/DML/DDL) → transpile →
     prepared SQLite statement with variables bound as native `@x`
     parameters; interpreted (DECLARE/SET/IF/WHILE/transactions/EXEC) →
     engine logic, scalar expressions evaluated via `SELECT (expr)`.
   - DDL additionally updates the catalog (`catalog.createTable` …).
4. **Results → tokens** — engine items (`rows` with TDS TypeInfo columns,
   `count`, `message`) render through `Tds.Token.*` encoders
   (`server/respond.ts`), split into packets, written back.
5. **RPC** — tedious sends parameterized queries as `sp_executesql`;
   parameters decode to JS values (`Tds.Value.decode`) and bind as scoped
   variables (`engine.executeSql`), OUTPUT values return as RETURNVALUE
   tokens.

## Key decisions

### Multiple-database ownership and resolution

- **One SQLite store and primary handle per SQL database** — `Server.databases`
  owns database id, SQL name, stable internal attachment alias, backing filename,
  `DatabaseSync`, catalog, module/sequence registries, and rowversion state.
  Every primary handle attaches every other store, so operations in the selected
  database use its store as SQLite `main` while three-part names reach an
  attachment. In-memory servers use named shared-cache `file:` URIs; file-backed
  child databases use deterministic sibling files. The initial database owns the
  server manifest, and `sys.databases` lifecycle rows are mirrored into every
  database catalog.
- **Encoded aliases isolate SQLite's namespace** — every handle attaches every
  other store under a deterministic hex-encoded SQL
  database name such as `mssqlite_73616c6573`. Prefixing avoids `main`/`temp`
  collisions and lets the transpiler resolve a three-part name without mutable
  global context. `ALTER DATABASE … MODIFY NAME` detaches the old alias and
  reattaches the same store under the newly encoded alias. `CREATE DATABASE` bootstraps
  its independent catalog before attaching it everywhere; `DROP DATABASE`
  detaches it from all surviving handles, closes the owner, removes manifest
  rows, and deletes only an engine-owned child file. Partial CREATE attachment
  failures detach and remove the new store before surfacing the error. The
  bundled SQLite limit of ten attachments caps one server at eleven logical
  databases, including the four system databases.
- **Object-position names resolve before transpilation** — the engine localizes
  explicit references to the selected database onto SQLite `main`, preserves
  other three-part database names, validates their target, and rewrites their
  database part to a stable attachment alias. Schema flattening remains unchanged
  inside that SQLite schema: `sales.dbo.orders` becomes
  `"mssqlite_73616c6573"."orders"`, and `sales.app.orders` becomes
  `"mssqlite_73616c6573"."app.orders"`. Column qualifiers are not database names and
  are left untouched. Four-part linked-server names remain unsupported.
- **Catalog and executable state are database-scoped** — DDL writes physical SQL
  through the selected session handle and updates the target database's primary
  catalog handle. Procedure/function/trigger/sequence maps and rowversion counters
  live on that database state, allowing identical schema/object names in different
  databases. A three-part procedure call temporarily executes under its owner
  database and restores the caller context afterward.
- **Transaction boundary follows SQLite attachments** — cross-database DML in one
  explicit transaction uses a single primary handle and therefore commits or
  rolls back together under SQLite's attached-database rules. Crash-atomicity
  across files requires a disk-backed `main` database and non-WAL journaling;
  SQLite cannot guarantee it when `main` is in-memory or WAL is enabled. Database
  lifecycle statements and cross-database DDL are rejected inside an active user
  transaction because catalog maintenance may require another primary handle.
  Statement-level interpreted triggers fire for DML issued in their selected
  database; firing a target database's triggers from a cross-database DML
  statement is deferred because transition temp tables and trigger-body name
  resolution cannot safely move between SQLite primary handles mid-transaction.
- **Session switching and temporary objects** — `USE` validates an online database,
  switches `Session.db`/database state immediately, synchronizes DMV database ids,
  and is rejected while a transaction is active. SQLite temp schemas belong to a
  handle, so local table variables/cursors remain scoped and cleaned by the engine,
  but user `#temp` objects created before `USE` are intentionally not visible from
  a different database handle. MARS remains separately unsupported.

- **TLS is full-session or absent** — supplying `listen({ tls: { key, cert } })`
  requires encryption by default and advertises `ENCRYPT_REQ`; optional mode
  encrypts TLS-capable clients but accepts explicit `ENCRYPT_NOT_SUP` as
  plaintext. Omitting TLS is the deliberate local-development mode and
  advertises `ENCRYPT_NOT_SUP`. Login-only TDS 7.x encryption and TLS-first
  TDS 8.0 are not implemented.
- **Authentication is explicit and precedes session creation** — every embedded
  listener selects either development-only `insecure` mode or `password` mode.
  Password mode stores only versioned scrypt hashes in configuration, requires
  full-session required TLS, validates case-insensitive SQL login names, and
  establishes the configured canonical name as the session/DMV identity. A
  credential provider is validated at startup and re-read on every LOGIN7 for
  atomic rotation without restart. Missing, malformed, unknown, and incorrect
  credentials all run one fixed-cost scrypt (a random dummy hash hides user
  existence), use `timingSafeEqual`, and receive generic 18456/state 1 before
  any database lookup or session allocation. Provider failures fail closed;
  hashes and submitted secrets are never logged or persisted in SQLite. SSPI,
  NTLM/Kerberos, and federated authentication remain unsupported.
- **Name flattening** (`transpile/quote.ts`) — database qualifiers become
  encoded attachment aliases while `dbo` drops; `sys` /
  `INFORMATION_SCHEMA` become flat lowercase names (`"sys.tables"`) that
  are *real SQLite tables/views* created by the catalog — catalog queries
  need no interception; other schemas flatten (`"app.users"`); `#temp` →
  SQLite `temp` schema.
- **Text sensitivity** — the default char/text baseline is `COLLATE NOCASE`;
  explicit supported SQL collations choose BINARY/NOCASE plus deterministic
  Unicode keys for case, accent and BIN2 behavior across predicates, ordering,
  uniqueness and indexes.
- **Variables are SQLite parameters** — `@x` passes through (SQLite
  supports `@`-parameters natively); each rendered statement carries its
  used-variable list so the engine binds exactly those. Globals map to
  `@__rowcount`-style parameters bound from session state.
- **Table variables are scoped temp tables** — `DECLARE @t TABLE (...)`
  allocates a collision-free `temp` table keyed by the active batch or
  procedure scope. The engine resolves object-position `@t` references
  before transpilation, keeps declared column metadata beside the backing
  name, and drops all backing tables on scope exit. Procedure calls and
  `sp_executesql` swap in isolated table-variable maps, so callers' table
  variables are not visible to nested work.
- **Built-in TVFs render as derived sources** — FROM-source function ASTs
  dispatch `STRING_SPLIT` to a JSON-array scalar adapter plus `json_each`,
  `OPENJSON` to JSON1 with SQL Server key/value/type or explicit WITH
  projections, and `GENERATE_SERIES` to a recursive CTE (the Node SQLite
  build has no series module). The transpiler attaches output type hints to
  simple TVF SELECTs so the engine can emit exact metadata before stepping,
  including for empty inputs.
- **APPLY has shape-specific lowering** — correlated two-argument
  STRING_SPLIT lowers to SQLite's implicitly lateral `json_each` source;
  simple correlated TOP (1) derived queries move equality correlation keys
  into a join and rank right rows with `ROW_NUMBER() OVER (PARTITION BY ...
  ORDER BY ...)`. CROSS APPLY uses INNER JOIN, OUTER APPLY uses LEFT JOIN.
  Complex correlation and star projection over ranked helper columns are
  rejected explicitly.
- **PIVOT/UNPIVOT use source-schema-aware lowering** — the engine annotates
  table leaves with catalog or table-variable column metadata. PIVOT emits
  one conditional aggregate per listed value and groups all remaining input
  columns. UNPIVOT materializes the source once, expands it with `UNION ALL`,
  and filters NULL values. The metadata annotations also provide stable TDS
  types for generated columns; incompatible known UNPIVOT types are rejected.
- **Advanced grouping expands before SQLite** — ROLLUP prefixes, CUBE's
  lattice, and explicit GROUPING SETS become ordered UNION ALL branches;
  duplicates are intentionally preserved. Each branch substitutes NULL for
  omitted grouping expressions and folds GROUPING(expr) to a tinyint 0/1.
  Simple sources are captured in one MATERIALIZED CTE (also stabilizing
  volatile derived expressions); joins currently repeat their source per
  branch because one CTE alias cannot preserve every original qualifier.
- **FOR JSON is an outer aggregation rewrite** — a synthetic inner SELECT
  evaluates and orders projected expressions once; PATH builds alias trees
  with JSON objects/patches, while AUTO classifies selected columns by source
  alias and groups one child array beneath each root row. JSON_QUERY and
  nested FOR JSON expressions are explicitly re-tagged as SQLite JSON after
  crossing the inner-query boundary. The output always has SQL Server's
  magic column name and nvarchar(max) hint.
- **User functions share persisted module infrastructure** — sys.objects uses
  `FN` for scalar and `IF` for inline TVFs; definitions live beside procedures
  in sys.sql_modules and reparse at server startup. Scalar names dispatch to
  varargs node:sqlite callbacks that enter an isolated engine variable scope;
  inline TVFs instead substitute argument ASTs into the stored SELECT before
  ordinary table-source resolution. Simple correlated inline sources reuse
  APPLY's extracted equality-key join lowering.
- **DML triggers are statement-level engine work** — persisted `TR` modules
  reparse into `server.triggers` at startup. A triggerable INSERT/UPDATE/DELETE
  runs inside a generated savepoint; `RETURNING` plus a pre-update snapshot
  produce complete multi-row images, which are copied to uniquely named temp
  tables and resolved as read-only `inserted` / `deleted` sources while the
  ordinary AST interpreter runs the body. User-authored T-SQL triggers deliberately
  do not use SQLite's row-level trigger subsystem (internal rowversion fallback
  triggers are the exception). INSTEAD OF triggers receive intended
  images and replace the base operation; direct self-recursion is suppressed,
  other nested triggers share the 32-level module limit, and an unhandled
  trigger error rolls back an enclosing user transaction. Trigger-body count
  items precede the originating statement count unless the trigger enables
  NOCOUNT; the originating statement still restores `@@ROWCOUNT`.
- **Cursors are session-owned materialized results** — DECLARE stores a SELECT
  AST and lifecycle state in `session.cursors`; OPEN resolves the active scope,
  executes the query once, and retains rows plus TDS column metadata. FETCH
  changes a bounded position, copies into variables or emits a one-row result,
  and sets connection-global `@@FETCH_STATUS`. LOCAL cursors declared in a
  batch, procedure, or trigger are removed on that scope's normal or exceptional
  exit; GLOBAL cursors survive batches until DEALLOCATE or session disposal.
- **Sequence allocation is server-global and rollback-independent** — `SO`
  definitions and counters persist in `sys.sequence_state` and surface through
  `sys.sequences`; server startup hydrates a BigInt registry keyed by schema and
  name. The nondeterministic NEXT VALUE UDF advances that shared registry
  synchronously, making sessions atomic without re-entering SQLite. Dirty values
  flush after each completed autocommit statement; inside a user transaction
  they flush immediately after COMMIT or ROLLBACK, so rollback never reissues a
  consumed value. CREATE/ALTER/DROP remain ordinary transactional catalog DDL.
- **Rowversion allocation is database-wide and rollback-independent** — one
  unsigned 64-bit counter persists as decimal text in `sys.rowversion_state`
  and hydrates into `server.rowversion` at startup. Ordinary INSERT/UPDATE ASTs
  inject the nondeterministic allocation UDF so RETURNING/OUTPUT observes the
  new big-endian binary(8) value; internal SQLite AFTER triggers cover MERGE,
  cascades, and indirect writes. Dirty state flushes with sequence state only
  outside user transactions, preserving rollback gaps. `timestamp` maps to the
  same system type id 189, `@@DBTS` reads without allocating, and catalog
  nullability chooses BIGBINARY(8) or BIGVARBINARY(8) TDS metadata.
- **`+` dispatch** — static inference picks `+` / `||`; unknown operand
  types fall back to the `mssqlite_add` UDF (numbers add, strings concat).
- **Opaque special types preserve identity at boundaries** — XML uses TEXT
  storage and native XML PLP; hierarchyid/geometry/geography use BLOB storage
  and native UDT PLP with catalog-selected UDT_INFO; sql_variant stores its
  complete SSVARIANT inner envelope as BLOB. DML target resolution injects
  pack/representation casts, while result metadata comes from the catalog.
  Unsupported operators/methods stop in the transpiler rather than acquiring
  accidental SQLite text/blob semantics.
- **Client result rows are positional** — every SELECT/OUTPUT statement calls
  `StatementSync.setReturnArrays(true)` before extraction. `columns()` and each
  row therefore share one stable index, preserving duplicate labels while
  origin-based catalog metadata remains ordered. Internal table snapshots and
  keyed DML bookkeeping continue using object rows where column names are
  unique.
- **UDF strategy** — anything without a clean SQLite rendering becomes an
  `mssqlite_*` function registered once per server (`engine/udf.ts`).
  Session-dependent UDFs (`db_name`, `scope_identity`, …) read
  `server.current`, set at batch entry — valid because execution is
  synchronous and single-threaded.
- **Catalog functions become subqueries** — `OBJECT_ID('t')` →
  `(SELECT object_id FROM "sys.objects" WHERE …)`; UDFs cannot re-enter
  the database connection.
- **IDENTITY = rowid alias** — `INTEGER PRIMARY KEY AUTOINCREMENT`
  (never-reused ids like MSSQL); TRUNCATE clears `sqlite_sequence`.
- **Session model** — one `DatabaseSync` per server, shared by sessions;
  SQLite serializes writes, one transaction at a time across sessions.
  Nested BEGIN TRAN counts `@@TRANCOUNT`; only the outermost pair touches
  SQLite; SAVE TRAN → savepoints. Under `SET XACT_ABORT ON` a caught
  error dooms the transaction (`XACT_STATE()` −1, COMMIT raises 3930).
- **Error handling** — TRY/CATCH is engine control flow: the try body's
  thrown `MssqlError` (severity ≤ 19) lands in a CATCH-scoped
  `session.caughtError` slot that `ERROR_NUMBER()`-family UDFs read;
  bare `THROW` rethrows it. RAISERROR severity ≤ 10 becomes a `message`
  item, higher throws.
- **Batch errors preserve statement boundaries** — parse/name-resolution and
  explicit THROW failures abort, while mapped constraint errors (515/547/2601/
  2627), conversion/arithmetic classes, RAISERROR below severity 20, and
  cursor/sequence runtime errors become ordered engine `error` items and the
  next statement executes. A `BatchError` still rejects the public call after
  execution but retains all prior rows/counts/errors for the TDS layer. Each
  successful statement resets `@@ERROR`; a failure sets it and zeroes
  `@@ROWCOUNT` before continuation. Qualifying errors under XACT_ABORT ON roll
  back the user transaction and abort; RAISERROR explicitly ignores XACT_ABORT.
  Integer CAST/CONVERT routes through a strict UDF so invalid text raises 245,
  overflow raises 8115, and TRY_CAST/TRY_CONVERT returns NULL instead of relying
  on SQLite's permissive conversion-to-zero behavior.
- **Integer arithmetic is checked before SQLite can coerce it** — inferred
  32/64-bit `+`, `-`, `*`, `/`, `%` expressions render one nondeterministic
  scalar UDF call, preserving one evaluation per operand, NULL propagation,
  integer division, 8134 divide-by-zero, and 8115 overflow. SUM uses checked
  32-bit state by default and 64-bit state for an explicit BIGINT argument.
  When both ARITHABORT and ANSI_WARNINGS are OFF, these failures produce NULL;
  otherwise they enter normal TRY/CATCH / statement-error / XACT_ABORT flow.
- **Stored procedures are interpreted AST** — `CREATE PROCEDURE` stores
  the parsed body in a server-wide registry (`server.procedures`, keyed
  `schema.name` lowercased) and persists the batch source in
  `sys.sql_modules` (reloaded and re-parsed on server start). EXEC
  swaps the session's variable-scope contents (the map reference is
  shared), binds positional/named/default/OUTPUT parameters, honors
  RETURN status and `@@NESTLEVEL` (cap 32). The RPC fallback renders
  `EXEC name @p = @p OUTPUT` over `executeSql` so driver `callProcedure`
  round-trips OUTPUT values and return status.
- **System procedures dispatch before user procedures** — the engine recognizes
  the final identifier case-insensitively, so `sp_help`, `sys.sp_help`, and RPC
  aliases share one implementation. `sp_help`, `sp_helptext`, `sp_columns`,
  `sp_tables`, `sp_who`, `sp_helpdb`, and `sp_spaceused` project typed result
  sets from the catalog and SQLite statistics. `sp_rename` changes the physical
  SQLite object and catalog identity under one savepoint, then updates the
  in-memory procedure, trigger, or sequence registry. The rename surface covers
  tables/views/modules/sequences, columns, and user indexes; function renames
  and dependency-text rewriting are deliberately unsupported. `sp_who` exposes
  all authenticated connections through the shared dynamic-session catalog;
  `sp_spaceused` reports local SQLite page estimates rather than SQL Server
  allocation-unit detail.
- **Dynamic management state follows request scope** — `session(server)` inserts
  a sleeping `sys.dm_exec_sessions` row, LOGIN synchronizes client identity,
  and the outer `executeBatch` call inserts request 0 before parsing. This makes
  `sys.dm_exec_requests` self-observable during execution. The request row is
  removed in `finally`, transaction/row/error counters are copied back to the
  session row, and TDS socket close removes the authenticated session.
- **MERGE is decomposed, not rendered** (`engine/merge.ts`) — one
  snapshot temp table computed against the pre-merge state joins source
  to target (LEFT JOIN, or FULL JOIN through a never-null source marker
  column when NOT MATCHED BY SOURCE arms exist) and stores each row's
  chosen arm tag plus every pre-evaluated SET / INSERT value; per-arm
  DELETE → UPDATE → INSERT statements then read only the snapshot, inside
  an implicit transaction when none is open. A target row matched by more
  than one source row raises 8672 before any mutation. OUTPUT reuses the
  snapshot as the `deleted` image (the target's pre-merge columns are
  captured alongside the arm values), records insert-arm rowids via
  RETURNING into a second temp table for the `inserted` image, and emits
  a UNION ALL of one SELECT per arm with `$action` folded to a literal.
- **Column metadata** — `StatementSync.columns()` origins resolve through
  the catalog for exact declared types. Computed-column types are inferred
  from base and earlier computed definitions before CREATE/ALTER rendering,
  then persisted in `sys.columns` for stable empty-result and TDS metadata.
- **Computed columns use SQLite generated columns** — non-PERSISTED definitions
  render VIRTUAL and PERSISTED definitions render STORED. Generated-expression
  mode selects deterministic checked-integer and exact-decimal UDFs; SQLite
  enforces forbidden direct writes and rejects nondeterministic definitions.
  `sys.computed_columns_extra` retains normalized definition text and the
  persistence bit behind the derived catalog view.
- **Date/time as TEXT** — MSSQL-format strings
  (`YYYY-MM-DD HH:MM:SS.fff…`). `datetimeoffset(n)` is a canonical fixed-scale
  string with its original signed offset; casts round through the exact TDS
  codec, DML/default/variable/RPC paths coerce at the declared scale, and
  result hints retain DATETIMEOFFSETN metadata. Predicates, IN/BETWEEN,
  ordering, uniqueness, and expression indexes use a deterministic UTC
  day+100ns key while stored/displayed values keep their local civil fields.
  DATEADD changes the local fields without timezone/DST lookup, DATEDIFF
  counts boundaries after UTC normalization, and TZOFFSET reads the retained
  offset. All TDS codecs use proleptic civil-date math rather than JS `Date`.
- **Collations use deterministic normalization keys** — parser ASTs retain
  column and expression COLLATE names; source metadata carries declarations
  into predicate and ORDER BY rendering. BINARY/NOCASE provide a baseline,
  while `mssqlite_collation_key` applies the supported case/accent/BIN2 matrix
  consistently to equality/range/IN/LIKE, ordering, uniqueness, and expression
  indexes. Catalog rows retain the SQL name and TDS TYPE_INFO derives matching
  LCID/flag/version/sort-id bytes. Conflicting implicit names raise 468.

## Extension points

- New built-in function → `transpile/functions.ts` handler (native
  rendering, rewrite, subquery) or new `mssqlite_*` UDF in
  `engine/udf.ts` — keep both sides in sync.
- New statement kind → AST type (`tsql/ast.ts`), grammar
  (`tsql/parse/statement.ts`), then either a transpile rendering or an
  engine interpretation (`engine/execute.ts` switch).
- New token/protocol feature → `tds/token/*`, wire it in
  `server/respond.ts` or `server/connection.ts`.

## Robustness invariants (enforced, regression-tested)

- **Decoders never hang or throw uncaught on hostile bytes.** `Message.push`
  rejects a packet whose length is below the header size (malformed framing →
  connection dropped, not an infinite loop); `AllHeaders.decode` rejects a
  zero-length inner header; `Value.decode` turns short/unknown-type reads into
  `Result` failures instead of exceptions. A deterministic fuzz sweep guards
  all top-level decoders (`packages/tds/src/robustness.test.ts`).
- **No silent wire corruption from oversized values.** A non-`max` value that
  would overflow its length prefix throws a clean error (mapped to an MSSQL
  error) rather than wrapping the prefix; column names are capped at 128 chars.
- **Canceled requests are honored.** A message whose EOM packet carries the
  IGNORE status bit (how tedious cancels mid-send) is discarded, not executed.
- **varchar/char/text use Windows-1252** (`@mssqlite/bytes` `Cp1252`), matching
  the advertised `SQL_Latin1_General_CP1` collation — `€`, em dash and smart
  quotes round-trip instead of corrupting as ISO-8859-1.

## Known limitations (v1)

See [TODO.md](../../../TODO.md) for the prioritized implementation briefs
toward broader SQL Server compatibility.

- No login-only TDS 7.x encryption or TLS-first TDS 8.0. No MARS and no
  SSPI/FedAuth; authenticated mode currently supports configured SQL logins.
- Cursor variables, positioned updates, and live KEYSET/DYNAMIC visibility are
  unsupported. Sequence DECIMAL/NUMERIC precision is capped at 18, cache options
  are metadata-only, same-row duplicate NEXT VALUE references are not coalesced,
  and an abnormal shutdown during an open user transaction can lose unflushed
  consumption state. Triggered DML does not yet support OUTPUT or
  UPDATE FROM, and MERGE does not yet fire DML triggers. MERGE OUTPUT may not
  reference source columns. Unlike SQL Server, table
  variable changes currently participate in the surrounding SQLite
  transaction and therefore roll back with it.
- Error classification currently covers mapped constraints, known conversion/
  arithmetic numbers, RAISERROR, cursor, sequence, and rowversion ranges; additional SQL
  Server statement-vs-batch cases will be added as their operations land.
  Checked integer width inference for uncast columns currently follows SUM(int) and
  treats scalar columns of unknown declared width conservatively.
- `USE db` switches the session label only — one database per server.
- DECIMAL/NUMERIC values use canonical fixed-scale strings and SQLite TEXT
  storage. The transpiler derives SQL Server precision/scale, routes casts,
  arithmetic, comparison, ordering, and aggregates through scaled-BigInt UDFs,
  and supplies decimal result hints; TDS encodes those strings directly.
- DATETIMEOFFSET values likewise use canonical TEXT rather than SQLite date
  functions. The local and UTC representations must both stay within years
  0001-9999; offsets are limited to ±14:00. Raw lexical comparison is never
  sufficient because different local strings can denote the same instant.
- `@@ROWCOUNT` after SELECT reflects rows returned; unsupported globals
  raise error 137. `ERROR_LINE()` is always 1 (no statement positions in
  the AST).
- SET NOCOUNT is captured when each statement completes. Engine row/count
  items retain their cardinality for `@@ROWCOUNT`, while response rendering
  clears DONE_COUNT and writes a zero count when hidden. Procedure, trigger,
  and dynamic-SQL scopes restore the caller's setting; mid-batch toggles
  therefore affect only subsequent completions.
