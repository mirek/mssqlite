# SQLite DDL Reference

This chapter is a compact reference for everything needed to map MSSQL DDL
onto a SQLite back-end: table/index/view/trigger creation and destruction,
constraint semantics (with SQLite's distinctive `ON CONFLICT` clauses), foreign
keys, generated columns, rowid quirks, schema introspection, and the practical
limits of `ALTER TABLE`.

## CREATE TABLE

### Syntax

```sql
CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] [schema-name.]table-name
  (
    column-def [, column-def]*
    [, table-constraint]*
  )
  [WITHOUT ROWID] [,] [STRICT]
;

-- Or, as a CTAS:
CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] [schema-name.]table-name
  AS select-stmt;
```

`column-def`:

```
column-name [type-name] [column-constraint]*
```

`column-constraint` (any number, in any order; an optional `CONSTRAINT name` prefix may precede each):

```
PRIMARY KEY [ASC|DESC] [conflict-clause] [AUTOINCREMENT]
NOT NULL [conflict-clause]
UNIQUE   [conflict-clause]
CHECK    ( expr )
DEFAULT  ( expr ) | literal-value | signed-number
COLLATE  collation-name
REFERENCES foreign-table [( column-name [, ...] )]
  [ON DELETE action] [ON UPDATE action] [MATCH name]
  [[NOT] DEFERRABLE [INITIALLY DEFERRED | INITIALLY IMMEDIATE]]
GENERATED ALWAYS AS ( expr ) [VIRTUAL | STORED]   -- "GENERATED ALWAYS" optional
```

`table-constraint`:

```
[CONSTRAINT name]
  PRIMARY KEY ( indexed-column [, ...] [AUTOINCREMENT] ) [conflict-clause]
  | UNIQUE      ( indexed-column [, ...] )               [conflict-clause]
  | CHECK ( expr )
  | FOREIGN KEY ( column-name [, ...] ) foreign-key-clause
```

`indexed-column` (table constraints only allow bare column names; expressions are
*not* allowed here — only in `CREATE INDEX`):

```
column-name [COLLATE collation-name] [ASC|DESC]
```

`conflict-clause`:

```
ON CONFLICT { ROLLBACK | ABORT | FAIL | IGNORE | REPLACE }
```

### Notes

- `IF NOT EXISTS`: makes the statement a no-op if a table/view of the same
  name exists. An existing **index** of the same name still raises an error.
- Names beginning with `sqlite_` are reserved and cannot be used.
- `schema-name` must be `main`, `temp`, or an attached database name. Using
  `TEMP`/`TEMPORARY` puts the table in the `temp` schema. Specifying both
  `TEMP` and a non-`temp` schema is an error.
- It is *not* an error to create a table with the same name as an existing
  trigger.
- A `CREATE TABLE` is removed with `DROP TABLE`.

### Column data types and affinity

SQLite uses **dynamic typing**: the declared `type-name` controls *affinity*,
not storage. Any value can be stored in any column unless `STRICT` is used.
The type-name is free-form (e.g. `VARCHAR(255)`, `BIGINT`, `DATETIME`); SQLite
maps it to one of TEXT / NUMERIC / INTEGER / REAL / BLOB by name-substring
rules. For MSSQL emulation, prefer the canonical names: `INTEGER`, `REAL`,
`TEXT`, `BLOB`, plus `NUMERIC` for decimals.

### DEFAULT clause

May be: `NULL`, a string/blob constant, a signed-number, an expression in
parentheses, or one of the case-independent keywords `CURRENT_TIME`,
`CURRENT_DATE`, `CURRENT_TIMESTAMP` (UTC, `"HH:MM:SS"`, `"YYYY-MM-DD"`,
`"YYYY-MM-DD HH:MM:SS"` respectively). The expression is "constant" if it
has no subqueries, columns, bound parameters, or double-quoted string
literals. `(expr)` is re-evaluated for each insert.

### COLLATE clause

Sets the default collation for the column. Built-in collations are `BINARY`
(default), `NOCASE`, and `RTRIM`. Additional collations may be registered via
`sqlite3_create_collation`.

### GENERATED ALWAYS AS

`col [type] [GENERATED ALWAYS] AS (expr) [VIRTUAL | STORED]` — `VIRTUAL` is
the default if no kind is given. Rules:

- May have `NOT NULL`, `CHECK`, `UNIQUE`, and `REFERENCES` constraints.
- Cannot be part of a `PRIMARY KEY`.
- Cannot have a `DEFAULT` clause.
- Expression may reference only constants and same-row columns, only
  deterministic scalar functions — no subqueries, aggregates, window funcs,
  table-valued funcs, or `ROWID` (but may reference the `INTEGER PRIMARY KEY`).
- `STORED` columns occupy disk; `VIRTUAL` computed at read time.
- May participate in indexes (a `VIRTUAL` column index becomes an
  expression index).
- Every table must have at least one non-generated column.
- `ALTER TABLE ADD COLUMN` can add `VIRTUAL` generated columns only, never
  `STORED`.
- `table_info` PRAGMA omits generated columns; use `table_xinfo`.

### PRIMARY KEY

- At most one per table; may be column-level or table-level.
- Composite primary keys are supported (table-level only).
- Only **column names** allowed in indexed-column list — no expressions.
- Optional on rowid tables; **required** on `WITHOUT ROWID` tables.
- Non-standard quirk: on rowid tables, `PRIMARY KEY` columns **allow NULL**
  unless explicitly declared `NOT NULL`, or the column is `INTEGER PRIMARY
  KEY`, or the table is `WITHOUT ROWID`, or the table is `STRICT`. (In a
  `WITHOUT ROWID` or `STRICT` table, PK columns are implicitly `NOT NULL`.)
- Uniqueness comparison treats NULLs as distinct from all other values
  (including other NULLs).
- Most `PRIMARY KEY`s are implemented as a unique index behind the scenes.
  Exceptions: `INTEGER PRIMARY KEY` (alias for rowid) and PRIMARY KEYs on
  `WITHOUT ROWID` tables (the clustered index itself).

### UNIQUE

- A table may have any number of UNIQUE constraints.
- NULLs are distinct (so multiple NULLs are allowed).
- Indexed-column list permits only bare column names — no expressions.
  Functional unique constraints must be expressed via `CREATE UNIQUE INDEX`.
- Implemented as a unique index.

### CHECK

- May appear as a column constraint or a table constraint (no functional
  difference). The expression is evaluated and CAST to NUMERIC; result 0 or
  0.0 = violation; NULL or any other value = OK. Subqueries are forbidden.
- Conflict action is always `ABORT`. (Syntax allows a conflict-clause on a
  table CHECK constraint for historic reasons but it has no effect.)
- May be disabled at runtime via `PRAGMA ignore_check_constraints=ON`.

### NOT NULL

- Column-level only; cannot be a table constraint.
- May carry a conflict-clause (default `ABORT`).

### Conflict-clause semantics (`ON CONFLICT ...`)

Each of `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, and `CHECK` has a per-constraint
conflict-resolution algorithm. The default for all is `ABORT`. Conflict actions:

| Action     | Meaning |
|------------|---------|
| `ROLLBACK` | Immediately roll back the entire transaction; statement aborts with `SQLITE_CONSTRAINT`. Outside an explicit transaction, behaves like `ABORT`. |
| `ABORT`    | (Default.) Back out changes from the current statement, but preserve effects of earlier statements in the transaction. Returns `SQLITE_CONSTRAINT`. |
| `FAIL`     | Abort the current statement with `SQLITE_CONSTRAINT`, but do **not** back out changes already made by this statement (e.g. earlier rows already updated). |
| `IGNORE`   | Skip the offending row and continue. No error. |
| `REPLACE`  | For `UNIQUE`/`PRIMARY KEY` violations: delete the pre-existing conflicting row(s), then insert/update. For `NOT NULL`: substitute the column's default value; if none, behave like `ABORT`. For `CHECK`: behave like `ABORT`. May fire `ON DELETE` triggers/cascades on the displaced rows. |

A `conflict-clause` on a constraint sets that constraint's default. A statement
may override per-execution with `INSERT OR ABORT / FAIL / IGNORE / REPLACE`,
`UPDATE OR ...`, or the abbreviated `INSERT OR REPLACE` → `REPLACE INTO`.

### ROWID vs WITHOUT ROWID

- Every ordinary "rowid table" has a hidden 64-bit signed integer key
  (`rowid` / `oid` / `_rowid_`). It is the true B-tree key.
- A single-column PK declared with exact type `INTEGER` becomes an alias for
  the rowid — the **INTEGER PRIMARY KEY**. (Variants like `INT`, `BIGINT`,
  `UNSIGNED INTEGER` do **not** alias the rowid; they create a separate
  unique index.) The historical quirk: `INTEGER PRIMARY KEY DESC` does *not*
  alias rowid (other forms with `ASC` or table-level `PRIMARY KEY(x DESC)` do).
- Rowid (and its alias) must hold integers; assigning blob/string/real that
  cannot be losslessly coerced → datatype mismatch error.
- On `INSERT` with NULL/omitted rowid, SQLite picks an unused integer
  (typically `MAX(rowid)+1`).
- `WITHOUT ROWID` (appended to `CREATE TABLE`): the table is stored as a
  clustered B-tree keyed by its PK. Requirements/effects:
  - `PRIMARY KEY` is required.
  - `INTEGER PRIMARY KEY` has no special meaning (no rowid alias).
  - `AUTOINCREMENT` is forbidden.
  - Every PK column is implicitly `NOT NULL` (standard-conformant).
  - `sqlite3_last_insert_rowid()`, incremental BLOB I/O, and
    `sqlite3_update_hook()` do not work.
  - Useful for tables with non-integer or composite PKs and small rows
    (≤~1/20 of page size). Avoid for single `INTEGER PRIMARY KEY`.
- The parent key of a foreign key cannot be rowid; must use named columns.

### STRICT tables

Append `STRICT` to `CREATE TABLE` (after `)`, with optional comma to
combine with `WITHOUT ROWID`):

- Every column **must** specify a datatype.
- Only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, or `ANY` are allowed.
- Non-conforming inserts raise `SQLITE_CONSTRAINT_DATATYPE` instead of being
  silently coerced. `ANY` columns accept anything.
- `PRIMARY KEY` columns are implicitly `NOT NULL`, but a NULL inserted into
  an `INTEGER PRIMARY KEY` is auto-replaced with a fresh integer.
- All other features (CHECK, FK, UNIQUE, DEFAULT, COLLATE, generated cols,
  ON CONFLICT, indexes, AUTOINCREMENT) behave identically to non-strict.

### AUTOINCREMENT

- Only valid on `INTEGER PRIMARY KEY` columns of rowid tables.
- Disallowed on `WITHOUT ROWID` and on any other column.
- Without AUTOINCREMENT, the rowid of a new row is normally `max(rowid)+1`,
  but may reuse the rowids of deleted rows.
- With AUTOINCREMENT, new rowids are strictly greater than any rowid that
  has *ever* existed in the table (tracked in the `sqlite_sequence` table).
  Once the max 64-bit integer has been used, further inserts fail with
  `SQLITE_FULL`. Rolled-back rowids are not consumed; failed inserts may
  leave gaps.
- AUTOINCREMENT adds CPU/IO overhead and is insufficient for MSSQL
  `IDENTITY`: it cannot represent non-key/decimal identities or signed custom
  increments, and rolled-back values may be reused. mssqlite therefore uses
  an engine-owned allocator and ordinary physical columns.
- `sqlite_sequence(name, seq)` is auto-created. It can be modified manually
  (e.g. `UPDATE sqlite_sequence SET seq=… WHERE name='t'` mirrors
  `DBCC CHECKIDENT`) but the table only tracks INSERT-driven increments.

### CREATE TABLE ... AS SELECT (CTAS)

```sql
CREATE TABLE new_t AS SELECT ...;
```

- Column count and names come from the SELECT result set.
- Column types follow expression affinity (`TEXT`, `NUM`, `INT`, `REAL`,
  or empty string for BLOB).
- The new table has **no PRIMARY KEY**, no constraints of any kind, NULL
  defaults, BINARY collation, and is a rowid table with contiguous rowids
  starting at 1.

### REFERENCES (column-level FK shorthand)

`col REFERENCES parent(col) ...` is equivalent to a `FOREIGN KEY(col)
REFERENCES parent(col) ...` table-constraint. If columns are omitted
(`REFERENCES parent`), the parent's PRIMARY KEY columns are used.

## Foreign Keys

### Enabling

Foreign-key constraint **enforcement** is off by default and must be enabled
per connection:

```sql
PRAGMA foreign_keys = ON;
```

- Cannot be toggled mid-transaction (silently ignored if attempted).
- `PRAGMA foreign_keys;` returns the current state (`0`/`1`); returns no
  rows if the build omits FK support entirely.
- A separate runtime override: `PRAGMA defer_foreign_keys = 1;` makes all
  FKs behave as deferred until the current transaction commits; auto-resets
  on each transaction.

### Constraint syntax (full form)

```
[FOREIGN KEY (col, ...)] REFERENCES parent-table [(parent-col, ...)]
  [ON DELETE action]
  [ON UPDATE action]
  [MATCH name]                          -- parsed but ignored (always MATCH SIMPLE)
  [[NOT] DEFERRABLE [INITIALLY DEFERRED | INITIALLY IMMEDIATE]]

action := NO ACTION | RESTRICT | SET NULL | SET DEFAULT | CASCADE
```

### Referential actions

- `NO ACTION` (default): the constraint is checked at end of statement
  (or at commit if deferred); no special cascade.
- `RESTRICT`: error raised **immediately** when the parent row is touched,
  even if the constraint is `DEFERRABLE INITIALLY DEFERRED`.
- `SET NULL`: set the child key columns of dependent rows to NULL.
- `SET DEFAULT`: set them to the column's `DEFAULT` value. Constraint
  satisfaction is still required, so this may itself fail if no parent row
  matches the default.
- `CASCADE`: propagate the parent DELETE/UPDATE to child rows.

`ON UPDATE` only fires if the parent key actually changes value.

### Deferred constraints

- `DEFERRABLE INITIALLY DEFERRED` → constraint checked at COMMIT.
- Anything else (`NOT DEFERRABLE`, `DEFERRABLE INITIALLY IMMEDIATE`,
  `DEFERRABLE` alone, or omitted) → immediate.
- SQLite does **not** support per-constraint runtime mode switching
  (no `SET CONSTRAINTS` equivalent). Use `PRAGMA defer_foreign_keys` instead.

### Parent key requirements

- Parent key columns must be the PK or covered by a `UNIQUE` constraint /
  unique index whose column order and collation match exactly.
- The rowid cannot be a parent key.
- Errors that need both child and parent definitions to detect (the parent
  doesn't exist, columns don't match a UNIQUE/PK) are **DML errors**
  ("foreign key mismatch") raised when DML is prepared, *not* at
  `CREATE TABLE` time.
- Errors detectable from the child alone are DDL errors raised by
  `CREATE TABLE`.

### Child indexing

Not required, but strongly recommended: every cascading parent operation
runs `SELECT rowid FROM child WHERE child_key = ?`. Without an index this
becomes a linear scan.

### FK interaction with ALTER / DROP

- `ALTER TABLE ADD COLUMN` cannot add a REFERENCES column unless its default
  is NULL (when FK enforcement is on).
- `ALTER TABLE ... RENAME TO` rewrites parent-table references in dependent
  schemas (when FK enforcement on, or always since 3.26 unless
  `PRAGMA legacy_alter_table=ON`).
- `DROP TABLE` issues an implicit `DELETE FROM` first (triggers do *not*
  fire; FK actions *do*). Violations of immediate FKs abort the DROP;
  deferred violations defer to commit time.

### Unsupported / surprising

- `MATCH SIMPLE | FULL | PARTIAL` is parsed but ignored — SQLite always
  uses `MATCH SIMPLE` semantics (any NULL child key satisfies the FK).
- No cross-schema FKs (`REFERENCES other_db.t`).
- FK action recursion depth is bounded by `SQLITE_MAX_TRIGGER_DEPTH`;
  `PRAGMA recursive_triggers` does **not** disable FK action recursion.

## ALTER TABLE

SQLite supports only a small set of alterations. The grammar:

```sql
ALTER TABLE [schema-name.]table-name
    RENAME TO new-table-name
  | RENAME [COLUMN] column-name TO new-column-name
  | ADD [COLUMN] column-def
  | DROP [COLUMN] column-name
;
```

### What's supported

- **RENAME TO**: renames a table within its database. Triggers and indices
  follow it. Since 3.25.0, references in trigger bodies, view bodies, and
  FK clauses are also rewritten (revert with `PRAGMA legacy_alter_table`).
  Cannot move between attached databases.
- **RENAME COLUMN**: rewrites the column name inside the table and in all
  indexes, triggers, and views that reference it. Fails if it would create
  a semantic ambiguity.
- **ADD COLUMN**: appends a column. Restrictions on the added column:
  - No `PRIMARY KEY` or `UNIQUE`.
  - Default may not be `CURRENT_TIME / CURRENT_DATE / CURRENT_TIMESTAMP`
    or a parenthesised expression.
  - `NOT NULL` requires a non-NULL default.
  - If FKs are on and the column has `REFERENCES`, default must be NULL.
  - May be `GENERATED ALWAYS ... VIRTUAL` but not `STORED`.
  - `CHECK` / generated-column `NOT NULL` constraints are validated against
    existing rows (since 3.37.0).
- **DROP COLUMN**: rewrites table content to purge the column. Fails if
  the column is part of the PK, has a UNIQUE constraint, is indexed
  (including being named in a partial index `WHERE`), participates in any
  CHECK / FK / generated-column expression that isn't the column itself,
  or appears in any trigger/view.

### What's NOT supported (work around with a 12-step rebuild)

- Changing a column's datatype, collation, or default.
- Adding/removing CHECK, FOREIGN KEY, UNIQUE, PRIMARY KEY constraints.
- Reordering columns.
- Removing/adding `WITHOUT ROWID` or `STRICT`.
- Adding a `STORED` generated column.

Generic procedure: turn FK enforcement off, `BEGIN`, build `new_X` with the
desired shape, `INSERT INTO new_X SELECT ... FROM X`, drop X, rename
`new_X` to X, recreate indexes/triggers/views, `PRAGMA foreign_key_check`,
commit. SQLite docs recommend this exact order (create-new → rename-into,
not rename-old-out → create-new) to keep cross-references intact.

### Underneath

SQLite stores schema as the original CREATE text in `sqlite_schema`. Most
ALTER operations are text rewrites of that field. With
`PRAGMA writable_schema=ON` you can edit `sqlite_schema.sql` directly
(dangerous; bump `PRAGMA schema_version` afterwards). Useful for changes
that don't affect on-disk row layout (adding/removing CHECK, FK, NOT NULL,
or default expressions).

## DROP TABLE

```sql
DROP TABLE [IF EXISTS] [schema-name.]table-name;
```

- Removes the table, all of its data, all of its indexes, and all triggers
  attached to it. Irrevocable.
- With FK enforcement on, an implicit `DELETE FROM` runs first. Triggers
  do not fire (they're dropped first), but FK actions do. Immediate FK
  violations abort the drop; deferred violations defer to commit.
- `IF EXISTS` suppresses the "no such table" error.

## CREATE INDEX

```sql
CREATE [UNIQUE] INDEX [IF NOT EXISTS] [schema-name.]index-name
  ON table-name ( indexed-column [, indexed-column]* )
  [WHERE expr]
;

indexed-column := { column-name | expr } [COLLATE collation-name] [ASC|DESC]
```

- Up to `SQLITE_LIMIT_COLUMN` columns per index.
- Indexes live in the same schema as their table; cannot index `temp` tables
  from another schema and vice versa.
- Drop with `DROP INDEX`.

### UNIQUE indexes

- NULLs are distinct (any number of NULLs allowed in a unique-indexed
  column). Matches PostgreSQL / Oracle / MySQL behavior; differs from MSSQL
  (which by default treats NULLs as equal, allowing only one).
  To emulate MSSQL while preserving nullable columns, use an expression key:
  `CREATE UNIQUE INDEX ix ON t((col IS NULL), ifnull(col, 0))`. Expand both
  expressions for every composite-key component; the null flag makes the
  arbitrary sentinel collision-free. Keep an intended partial-index WHERE
  predicate unchanged.

### Partial indexes (`WHERE`)

- Only rows for which the `WHERE` expression evaluates true are indexed.
- `WHERE` may reference any column of the indexed table, not only the
  indexed columns. Disallowed: subqueries, references to other tables,
  non-deterministic functions, bound parameters.
- Query planner can use a partial index only if it can prove the query's
  WHERE implies the index's WHERE (`W ⇒ X`). SQLite uses two simple rules:
  (1) a term in the query matches an exact term in the index, and (2)
  `z IS NOT NULL` in the index matches any non-`IS` comparison on `z` in
  the query. No algebraic reasoning is performed — `b=6` and `6=b` only
  match if the index has `b=6`.
- Useful for emulating MSSQL filtered indexes.

### Expression indexes

- Index keys can be arbitrary expressions over the indexed table's columns.
- Only **deterministic** functions allowed (application-defined functions
  must be registered with `SQLITE_DETERMINISTIC`). `random()`,
  `sqlite_version()`, etc. are disallowed.
- No subqueries, no references to other tables.
- The query planner matches expressions textually (modulo whitespace).
  `x+y` in the index does **not** match `y+x` in the query.
- Expressions are valid only in `CREATE INDEX`, never inside `PRIMARY KEY`
  or `UNIQUE` constraints in `CREATE TABLE`.

### Descending / NULLS ordering

- `ASC` / `DESC` per column is honored on modern schema formats (default
  since 3.7.10).
- `NULLS FIRST` / `NULLS LAST` is *not* supported on indexes. NULLs are
  ordered smaller than any other value, so NULLs sit at the start of ASC
  indexes and the end of DESC indexes.

### COLLATE

Each column may carry a `COLLATE collation-name` override. Default is
the column's declared collation, else `BINARY`.

### Auto-created indexes

UNIQUE and PRIMARY KEY constraints (on rowid tables) cause SQLite to
implicitly create indexes named `sqlite_autoindex_TABLE_N`. They appear
in `sqlite_schema` with `sql IS NULL`.

## DROP INDEX

```sql
DROP INDEX [IF EXISTS] [schema-name.]index-name;
```

Removes a user-created index. Implicit `sqlite_autoindex_*` indexes are
removed only when their constraint is dropped (typically via table rebuild).

## CREATE VIEW

```sql
CREATE [TEMP | TEMPORARY] VIEW [IF NOT EXISTS] [schema-name.]view-name
  [ ( column-name [, column-name]* ) ]
  AS select-stmt;
```

- A view is a named SELECT. Use the explicit column-name list (added in
  3.9.0) for stable column names; otherwise names derive from the
  result-set expression aliases.
- `TEMP` views live for the connection only.
- Views are **read-only**: `INSERT`, `UPDATE`, `DELETE` against a view are
  errors. Make a view updatable by attaching `INSTEAD OF` triggers (one per
  statement type that should be permitted).
- Remove with `DROP VIEW`.

## DROP VIEW

```sql
DROP VIEW [IF EXISTS] [schema-name.]view-name;
```

Removes the view definition from the schema; base-table data is untouched.

## CREATE TRIGGER

```sql
CREATE [TEMP | TEMPORARY] TRIGGER [IF NOT EXISTS] [schema-name.]trigger-name
  [ BEFORE | AFTER | INSTEAD OF ]
  { DELETE | INSERT | UPDATE [OF column-name [, column-name]*] }
  ON table-or-view-name
  [ FOR EACH ROW ]
  [ WHEN expr ]
BEGIN
  trigger-stmt;
  ...
END;
```

`trigger-stmt` is one of `UPDATE`, `INSERT`, `DELETE`, or `SELECT`.

### Timing

- `BEFORE` / `AFTER`: only on ordinary tables. `BEFORE` is the default if
  neither keyword is given.
- `INSTEAD OF`: only on views. Used to make views writable.

### Row vs. statement

- Only `FOR EACH ROW` is supported (FOR EACH STATEMENT is not). The clause
  is therefore optional.

### Event and `UPDATE OF`

- One event per trigger: `DELETE`, `INSERT`, or `UPDATE [OF col...]`.
- `UPDATE OF col` fires only if `col` appears on the LHS of the `SET` of
  the firing UPDATE. **Bug-by-design**: unrecognized column names in the
  `OF` list are silently ignored.

### `WHEN` clause

Optional predicate evaluated per row; trigger body runs only if true.

### `NEW.` / `OLD.` references

| Event   | OLD     | NEW     |
|---------|---------|---------|
| INSERT  | invalid | valid   |
| UPDATE  | valid   | valid   |
| DELETE  | valid   | invalid |

- `NEW.rowid` is undefined inside a `BEFORE INSERT` if the rowid is not
  explicitly given.

### Restrictions on trigger-body DML

- Target table must be unqualified (`tbl`, not `db.tbl`) — except a TEMP
  trigger may reference any attached schema and target tables there.
- `INSERT INTO t DEFAULT VALUES` is not allowed inside a trigger.
- No `INDEXED BY` / `NOT INDEXED` clause on UPDATE/DELETE.
- No `ORDER BY` / `LIMIT` on UPDATE/DELETE inside triggers (even if the
  compile option `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` is set).
- CTEs are not directly supported as trigger statements but can appear
  inside sub-selects within trigger statements.

### Conflict handling inside triggers

- `INSERT OR ... / UPDATE OR ...` inside a trigger may specify its own
  conflict action.
- However if the **outer** statement (the one that caused the trigger to
  fire) carries a conflict clause, the outer's policy overrides the
  trigger's policy.

### `RAISE()` function

Inside a trigger only:

```
RAISE(ROLLBACK, 'msg')
RAISE(ABORT,    'msg')
RAISE(FAIL,     'msg')
RAISE(IGNORE)
```

- The first three abort with `SQLITE_CONSTRAINT` and the given message
  (message can be any SQL expression from 3.47.0).
- `RAISE(IGNORE)` abandons the current trigger program, its calling
  statement, and any pending trigger programs — but does not roll back
  the changes already made.

### Recursion

- A trigger can fire other triggers and (with `PRAGMA
  recursive_triggers=ON`, the default since 3.7.0) re-trigger itself
  indirectly. Depth bounded by `SQLITE_MAX_TRIGGER_DEPTH` /
  `SQLITE_LIMIT_TRIGGER_DEPTH`.
- FK actions count toward the same depth budget but are *not* governed
  by `recursive_triggers`.

### BEFORE-trigger hazards

If a `BEFORE UPDATE`/`BEFORE DELETE` modifies or deletes the row that
triggered it, the subsequent UPDATE/DELETE behavior is undefined and
AFTER triggers may or may not run. Prefer AFTER triggers for safety.

### TEMP triggers on non-TEMP tables

A `TEMP` trigger can fire on `main.tab1`. Always schema-qualify the
target (`ON main.tab1`, not `ON tab1`) to avoid accidental rebinding
when the schema reloads.

### Dropping

```sql
DROP TRIGGER [IF EXISTS] [schema-name.]trigger-name;
```

Triggers are also dropped automatically when their table is dropped (but
not when other referenced tables are dropped).

## CREATE VIRTUAL TABLE

```sql
CREATE VIRTUAL TABLE [IF NOT EXISTS] [schema-name.]table-name
  USING module-name [ ( module-arg [, module-arg]* ) ];
```

- Backed by a registered module (FTS5, R-Tree, JSON, custom). Module args
  are passed verbatim to the module.
- Cannot have indexes or triggers attached.
- Removed with ordinary `DROP TABLE` (there is no `DROP VIRTUAL TABLE`).

## DROP TRIGGER / DROP VIEW / DROP INDEX (summary)

```sql
DROP TRIGGER [IF EXISTS] [schema-name.]trigger-name;
DROP VIEW    [IF EXISTS] [schema-name.]view-name;
DROP INDEX   [IF EXISTS] [schema-name.]index-name;
```

All three accept `IF EXISTS` to suppress the missing-object error.

## sqlite_schema (a.k.a. sqlite_master)

Every database has a single read-only catalog table that describes all
tables, indexes, views, and triggers in that database:

```sql
CREATE TABLE sqlite_schema(
  type     TEXT,    -- 'table' | 'index' | 'view' | 'trigger'
  name     TEXT,    -- object name
  tbl_name TEXT,    -- table the object belongs to (= name for tables/views)
  rootpage INTEGER, -- B-tree root page for tables/indexes; 0/NULL for views/triggers/vtabs
  sql      TEXT     -- normalized CREATE statement (NULL for auto-created indexes)
);
```

### Names

- Canonical: `sqlite_schema` (works anywhere, optionally qualified
  `main.sqlite_schema`, `temp.sqlite_schema`).
- Historical aliases: `sqlite_master` (works on `main`), `sqlite_temp_schema`
  and `sqlite_temp_master` (TEMP only).

### Field details

- `type`: `'table'` (covers both ordinary and virtual tables), `'index'`,
  `'view'`, `'trigger'`.
- `name`: object name. UNIQUE / PRIMARY KEY (on rowid tables) cause
  implicit indexes named `sqlite_autoindex_TABLE_N`. WITHOUT ROWID
  tables reserve the N slot for the PK but emit no `sqlite_schema` row
  for it. `INTEGER PRIMARY KEY` never produces an autoindex entry.
- `tbl_name`: the parent table. For triggers it's the table or view the
  trigger fires on.
- `rootpage`: 0 or NULL for views, triggers, virtual tables.
- `sql`: original CREATE text with normalizations applied — `CREATE`,
  `TABLE`/`VIEW`/`TRIGGER`/`INDEX` upper-cased, `TEMP`/`TEMPORARY`
  removed, any database qualifier removed, leading whitespace dropped,
  inter-keyword whitespace collapsed. `NULL` for auto-created indexes.

### Use for introspection

Common patterns for emulating MSSQL system views:

```sql
-- list all user tables
SELECT name FROM sqlite_schema
 WHERE type='table' AND name NOT LIKE 'sqlite_%'
 ORDER BY name;

-- columns of a table (prefer PRAGMA for typed results)
PRAGMA table_xinfo('mytable');   -- includes generated/hidden columns
PRAGMA index_list('mytable');
PRAGMA index_info('myindex');
PRAGMA foreign_key_list('mytable');

-- gather schema fragments associated with a single table
SELECT type, sql FROM sqlite_schema WHERE tbl_name='mytable';
```

### Writability

`sqlite_schema` is normally read-only. With `PRAGMA writable_schema=ON` it
can be edited (used for offline schema surgery; bump `PRAGMA
schema_version`). Misuse will corrupt the database.

## Imposter Tables (brief)

A debugging-only mechanism that attaches a `WITHOUT ROWID`-shaped CREATE
TABLE to the b-tree of an existing index, exposing the index content as a
queryable table. Created either by editing `sqlite_schema` directly (with
`writable_schema=ON`, permanent and corrupting) or transiently via
`sqlite3_test_control(SQLITE_TESTCTRL_IMPOSTER, ...)` / `.imposter` in the
CLI. **Do not use in applications.** Imposter tables are for analysis and
testing only; misuse causes index corruption recoverable only via `REINDEX`.

## Quick conflict-action cheat sheet (for MSSQL emulation)

| Need (MSSQL behavior)                            | SQLite construct |
|--------------------------------------------------|------------------|
| Default constraint-violation error               | (none — `ABORT` is default) |
| `IGNORE_DUP_KEY` on unique index                 | `ON CONFLICT IGNORE` on the UNIQUE constraint, or `INSERT OR IGNORE` |
| `MERGE` upsert                                   | `INSERT ... ON CONFLICT(...) DO UPDATE SET ...` (UPSERT), or `INSERT OR REPLACE` (drops & re-inserts; fires triggers) |
| Filtered unique index where MSSQL has many NULLs but SQLite would already permit them | None needed — SQLite NULLs are distinct |
| `IDENTITY(seed,increment)`                       | Ordinary typed NOT NULL column plus engine-owned allocation |
| `ROWVERSION` / `TIMESTAMP`                       | Emulate via trigger writing `unixepoch()` into a column |
| Computed column (persisted)                      | `GENERATED ALWAYS AS (expr) STORED` |
| Computed column (non-persisted)                  | `GENERATED ALWAYS AS (expr) VIRTUAL` |
| `WITH CHECK OPTION` on view                      | Not supported — enforce via `INSTEAD OF` triggers |
| Disable / re-enable FK constraints in bulk load  | `PRAGMA foreign_keys=OFF` then `=ON`; or wrap in transaction with `PRAGMA defer_foreign_keys=1` |
