# DML in SQLite

Reference for the data-manipulation statements available in SQLite: `INSERT`,
`UPDATE`, `DELETE`, `REPLACE`, `UPSERT` (`ON CONFLICT`), the `RETURNING` clause,
the `INDEXED BY` / `NOT INDEXED` hints, and `ON CONFLICT` resolution algorithms.
This chapter is the authoritative DML reference for an LLM building an
MSSQL-compatible front end on top of SQLite — special attention is paid to
behaviours that differ from T-SQL and to non-obvious conflict semantics.

## INSERT

### Three basic forms

```sql
-- 1. VALUES form: one or more new rows
INSERT INTO tbl(col1, col2, ...) VALUES (e1, e2, ...), (e1, e2, ...), ... ;

-- 2. SELECT form: one new row per result row
INSERT INTO tbl(col1, col2, ...) SELECT ... ;

-- 3. DEFAULT VALUES form: exactly one row, every column gets its default
INSERT INTO tbl DEFAULT VALUES;
```

### VALUES (single- and multi-row)

* Multi-row `VALUES` is supported: `INSERT INTO t VALUES (1,2),(3,4),(5,6);`.
* If the column-name list is **omitted**, the number of values per tuple must
  equal the number of columns in the table (in declared order).
* If a column-name list is present, the number of values per tuple must equal
  the number of named columns; unnamed columns get their `DEFAULT` (or `NULL`
  if no default).
* Expressions in `VALUES` may be arbitrary scalar expressions (not just
  literals), but they cannot reference other rows of the same statement.

### INSERT ... SELECT

* Any `SELECT` is allowed, including compound (`UNION`/`INTERSECT`/`EXCEPT`),
  `ORDER BY`, `LIMIT`, and CTEs.
* Column count of the `SELECT` must match the column list (or the table arity
  if no column list).
* **Parsing ambiguity with UPSERT:** when an `INSERT ... SELECT` is followed by
  `ON CONFLICT`, always include a `WHERE` clause (even `WHERE true`) so the
  parser knows `ON` starts the upsert clause, not a join constraint.
  ```sql
  INSERT INTO t1 SELECT * FROM t2 WHERE true
  ON CONFLICT(x) DO UPDATE SET y = excluded.y;
  ```

### DEFAULT VALUES

* Inserts exactly one row; each column receives its declared `DEFAULT` value
  or `NULL` if none.
* **Not allowed inside triggers** and **cannot be combined with an UPSERT
  clause**.

### OR <conflict-action> prefix

`INSERT` (and `UPDATE`) may be prefixed with an alternative conflict-resolution
algorithm to override the table-level default for that one statement:

```sql
INSERT OR ROLLBACK INTO t ... ;
INSERT OR ABORT    INTO t ... ;   -- ABORT is the global default
INSERT OR FAIL     INTO t ... ;
INSERT OR IGNORE   INTO t ... ;
INSERT OR REPLACE  INTO t ... ;
```

The five actions are defined in detail under [ON CONFLICT actions](#on-conflict-actions).
`REPLACE INTO ...` is a MySQL-compatible shorthand for `INSERT OR REPLACE INTO ...`.

### Optional clauses

* `schema-name.table-name` is allowed only in **top-level** `INSERT`s — never
  inside trigger bodies.
* `AS alias` may rename the target table; useful inside `WHERE`/`SET` of an
  upsert clause. Harmless if no upsert is present.
* `RETURNING ...` may appear at the end of any top-level `INSERT` (see
  [RETURNING](#returning)).

## UPDATE

### Basic form

```sql
UPDATE [OR <action>] qualified-table-name [INDEXED BY name | NOT INDEXED]
SET col = expr [, col = expr | (col, col, ...) = (expr, expr, ...)] ...
[FROM table-or-subquery [, ...]]
[WHERE expr]
[RETURNING ...]
[ORDER BY ...] [LIMIT n [OFFSET m]];     -- only if SQLITE_ENABLE_UPDATE_DELETE_LIMIT
```

* Without `WHERE`, **every** row is updated.
* Columns not assigned by `SET` are left unmodified.
* Right-hand-side expressions are **evaluated against the pre-update row**;
  all RHS expressions are computed before any assignment is performed.
* If a column appears more than once on the left, only the rightmost
  assignment takes effect.

### Compound row-value assignment (since 3.15.0)

```sql
UPDATE t SET (a, b, c) = (SELECT x, y, z FROM s WHERE s.id = t.id);
UPDATE t SET (a, b)    = (b, a);          -- swap two columns
```

The right-hand-side row value must have the same arity as the parenthesised
column list.

### UPDATE FROM (since 3.33.0)

```sql
UPDATE inventory
SET    quantity = quantity - daily.amt
FROM   (SELECT sum(quantity) AS amt, itemId
        FROM sales GROUP BY 2) AS daily
WHERE  inventory.itemId = daily.itemId;
```

* The **target table is not listed in the FROM clause** — this is the
  PostgreSQL convention, not the T-SQL one. SQL Server requires the target
  table to appear in `FROM`; SQLite forbids this unless you are doing a
  deliberate self-join, in which case the FROM-side reference **must use a
  different alias**.
* If the join produces more than one source row for a given target row, **one
  of those source rows is picked arbitrarily** and the choice may change
  between releases.
* The target table may still carry `INDEXED BY` / `NOT INDEXED` and `OR
  <action>` modifiers; the source tables in `FROM` cannot.
* MSSQL users porting `UPDATE t SET ... FROM t JOIN s ON ...` must
  **rewrite**: drop the target table from `FROM`, keep just `s`, and move the
  join condition into `WHERE`.

### OR <conflict-action> prefix

Identical semantics to `INSERT OR <action>` — overrides the table default for
this one statement.

### ORDER BY / LIMIT

Optional and **only available when SQLite was built with
`SQLITE_ENABLE_UPDATE_DELETE_LIMIT`**. The standard amalgamation does not
enable it; assume it is off unless you know otherwise.

* `LIMIT n`: at most `n` rows updated. Negative `n` means "no limit".
* `ORDER BY ... LIMIT n`: chooses *which* `n` rows fall under the limit. It
  does **not** define the order in which rows are physically modified — that
  remains arbitrary.
* `OFFSET m`: skip the first `m` rows of the ordered set.
* `LIMIT` / `ORDER BY` / `INDEXED BY` / `NOT INDEXED` are **never allowed
  inside triggers**, regardless of compile flags.

### Restrictions inside CREATE TRIGGER

* Table name must be unqualified (no `schema.` prefix).
* No `INDEXED BY` / `NOT INDEXED`.
* No `LIMIT` / `ORDER BY`.
* No `RETURNING`.

## DELETE

### Basic form

```sql
DELETE FROM qualified-table-name [INDEXED BY name | NOT INDEXED]
[WHERE expr]
[RETURNING ...]
[ORDER BY ...] [LIMIT n [OFFSET m]];     -- only if SQLITE_ENABLE_UPDATE_DELETE_LIMIT
```

* No `WHERE` → all rows are deleted (subject to the truncate optimization
  below).
* `LIMIT` / `ORDER BY` semantics identical to `UPDATE`: `ORDER BY` selects
  *which* rows are removed, not in what order they are physically removed.
  The `RETURNING` output order is **not** governed by `ORDER BY`.

### Truncate optimization

When all of the following hold:

* `WHERE` is omitted,
* `RETURNING` is omitted,
* the table has no triggers,

SQLite erases the table content as a single page operation rather than
visiting rows individually. `sqlite3_changes()` still reports the correct row
count (this was broken before 3.6.5 but is fixed).

To disable:
* compile-time: `SQLITE_OMIT_TRUNCATE_OPTIMIZATION`,
* run-time: an authorizer callback that returns `SQLITE_IGNORE` for
  `SQLITE_DELETE` causes per-row deletion.

When mapping `TRUNCATE TABLE` from T-SQL, a bare `DELETE FROM t` already
benefits from this optimization on trigger-free, non-FK tables.

### Restrictions inside CREATE TRIGGER

Same set as `UPDATE`: unqualified table name only; no `INDEXED BY`,
`NOT INDEXED`, `LIMIT`, `ORDER BY`, or `RETURNING`.

## UPSERT (INSERT ... ON CONFLICT ...)

UPSERT is an SQLite extension modelled on PostgreSQL. Added in 3.24.0;
multi-clause and target-less forms added in 3.35.0.

### Syntax

```sql
INSERT INTO tbl(col1, col2, ...) VALUES (...) [, (...) ...]
ON CONFLICT (target-col [, target-col ...]) [WHERE expr]   -- conflict target
    DO NOTHING
ON CONFLICT (target-col [, target-col ...]) [WHERE expr]
    DO UPDATE SET col = expr [, ...] [WHERE expr]
ON CONFLICT                                                 -- target may be
    DO UPDATE SET col = expr [, ...] [WHERE expr];          -- omitted on the LAST clause only
```

* Multiple `ON CONFLICT` clauses are checked in order. Only the first matching
  clause fires for a given row; the rest are skipped for that row.
* The conflict target may be omitted **only on the last** `ON CONFLICT` clause
  and acts as a catch-all for any uniqueness violation not handled earlier.
* In a multi-row insert, each row is decided independently.

### What counts as a "conflict"

UPSERT fires **only on uniqueness violations** — i.e. an explicit `UNIQUE`
constraint, a `PRIMARY KEY`, or a unique index. It does **not** intervene on
`NOT NULL`, `CHECK`, foreign-key, or trigger-raised constraint failures; those
fall through to the surrounding conflict-resolution algorithm.

### DO NOTHING

Silently skip the offending row; continue with the next row of the insert.

### DO UPDATE SET ...

Update the existing row instead of inserting. Within the `SET` expressions and
the optional trailing `WHERE`:

* A bare column reference (`col`, or `tbl.col`) refers to the **pre-existing**
  row's value (PostgreSQL requires the qualified form; SQLite accepts both).
* `excluded.col` refers to the value that **would have been inserted** had the
  conflict not occurred. This is the only way to reach the would-be-inserted
  values.
* The optional trailing `WHERE` **does not restrict the set of rows updated**
  (which is always exactly the one conflicting row); it converts the
  `DO UPDATE` into a no-op when false.

```sql
INSERT INTO phonebook(name, phone) VALUES('Alice', '704-555-1212')
ON CONFLICT(name) DO UPDATE
    SET phone = excluded.phone
    WHERE excluded.phone <> phonebook.phone;
```

### Important UPSERT limitations

* **Does not work on virtual tables.**
* The conflict-resolution mode used **inside** `DO UPDATE` is always `ABORT`,
  regardless of any enclosing `OR <action>` prefix or table default. Any
  constraint violation while applying the `DO UPDATE` aborts the entire
  `INSERT` statement.
* `INSERT ... DEFAULT VALUES` cannot carry an UPSERT clause.
* When the values come from a `SELECT`, always include a `WHERE` clause (even
  `WHERE true`) to disambiguate `ON` (see [INSERT ... SELECT](#insert--select)).

## REPLACE statement

`REPLACE INTO t ...` is purely an alias for `INSERT OR REPLACE INTO t ...`,
provided for MySQL compatibility. All `INSERT` forms (VALUES, SELECT) work.

### Semantics (inherited from `OR REPLACE`)

When the would-be-inserted row collides on a `UNIQUE` or `PRIMARY KEY`
constraint:

1. The pre-existing conflicting row(s) are **deleted**.
2. The new row is then inserted.

Side effects worth flagging:

* **Triggers**: pre-existing rows are deleted via the normal delete path, so
  `BEFORE DELETE` / `AFTER DELETE` triggers on the target table fire for each
  removed row.
* **Foreign keys**: with FKs enforced (`PRAGMA foreign_keys = ON;`), the
  cascade rules of any child tables referencing the deleted rows take effect.
  If a referencing row has `ON DELETE RESTRICT` (or no action and isn't
  cascaded), the replace will fail with a foreign-key violation — which,
  unlike a unique-key collision, is **not** caught by `REPLACE` and propagates
  as a normal constraint error.
* **rowid**: a replaced row gets a fresh rowid. If the table uses
  `INTEGER PRIMARY KEY` and the new row supplies that key explicitly, the new
  row keeps that key. If it does not, SQLite chooses a new rowid as for any
  insert. For `INTEGER PRIMARY KEY AUTOINCREMENT`, the deleted rowid is **not**
  reused, and `sqlite_sequence` advances normally on the insert side.
* `REPLACE` does not behave like an `UPDATE`: it removes the old row entirely,
  so columns not mentioned in the insert revert to their declared defaults
  (or `NULL`).

For MSSQL emulation, prefer real UPSERT (`INSERT ... ON CONFLICT ... DO
UPDATE`) over `REPLACE` whenever you want T-SQL `MERGE`-style update
semantics — `REPLACE`'s delete+insert can lose unrelated columns and trigger
unwanted FK cascades.

## RETURNING

Available on top-level `INSERT`, `UPDATE`, and `DELETE` since SQLite 3.35.0.

```sql
INSERT INTO t(a, b) VALUES (1, 2) RETURNING id, a, b;
UPDATE t SET b = b + 1 WHERE a > 0 RETURNING id, b AS new_b;
DELETE FROM t WHERE a < 0 RETURNING *;
```

### Allowed expressions

* Any scalar expression over columns of the target table, plus literals,
  built-in functions, scalar subqueries, etc.
* `AS alias` is allowed to rename a returned column.
* `*` expands to all non-hidden columns of the target table.
* **Not allowed at top level**: aggregate functions and window functions.
  (They are allowed inside subqueries within the `RETURNING` list.)
* **May only reference the target table.** In an `UPDATE ... FROM` statement,
  columns of the `FROM`-side tables are **not** available.

### Which value is returned?

* `INSERT` and `UPDATE`: the **post-change** column values of the target row.
* `DELETE`: the **pre-delete** column values of the row that was removed.
* `UPSERT`: a single result set containing both the freshly-inserted rows and
  the rows touched by `DO UPDATE`. There is no built-in way to tell them
  apart in the result set; either include an `xmax`-style sentinel via a
  computed column or use `excluded.col` placeholders in the SET list (e.g.
  `RETURNING id, CASE WHEN ... END AS was_update`).
* AFTER triggers that modify the row run *after* the values for `RETURNING`
  are captured, so changes those triggers make are **not** visible in the
  output.
* Foreign-key cascades and trigger-driven side effects on **other** tables
  are not reflected in `RETURNING` at all — only directly modified rows of
  the target table appear.

### Ordering and timing

* **Output order is arbitrary** and may differ between releases or even
  between executions of the same statement. There is no way to force an
  order: a top-level `ORDER BY` clause (only available with
  `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`) governs which rows are touched, not
  the `RETURNING` output order.
* On the first `sqlite3_step()`, all database modifications are completed
  and the entire `RETURNING` output is materialised in memory; subsequent
  `sqlite3_step()` calls stream the rows out. Large `RETURNING` outputs can
  use substantial temporary memory.
* Self-referential subqueries in `RETURNING` expressions (e.g. a subquery
  reading the same table that is being modified) are **indeterminate** — the
  computation order vs. the modification order is unspecified.

### Restrictions

* **Not allowed inside triggers.**
* **Not allowed on virtual tables** for `DELETE` and `UPDATE`. (It works for
  virtual-table `INSERT` if the module supports it.)
* The whole statement, even with `RETURNING`, **cannot be used as a
  subquery** or as a CTE source — `RETURNING` rows go to the client only.

## INDEXED BY / NOT INDEXED

```sql
DELETE FROM t INDEXED BY idx_t_a WHERE a = ?;
UPDATE t INDEXED BY idx_t_a SET b = ? WHERE a = ?;
UPDATE t NOT INDEXED       SET b = ? WHERE a = ?;
SELECT * FROM t INDEXED BY idx_t_a WHERE a = ?;
```

Available on `SELECT`, `UPDATE`, and `DELETE` (the `qualified-table-name`
production).

* `INDEXED BY idx` is a **requirement**, not a hint: if the planner cannot
  use that index, statement preparation fails. It is intended to detect
  schema changes that silently alter the chosen plan in regression tests,
  not to tune queries.
* `NOT INDEXED` forbids the planner from using any index — including indices
  implied by `UNIQUE` / `PRIMARY KEY` constraints — on that table. The rowid
  is still usable for direct lookups.
* Not allowed inside triggers (for `UPDATE` / `DELETE`).
* Not portable: this is an SQLite-specific extension.

For tuning, prefer `ANALYZE`, careful query rewriting, or the unary `+`
operator (which disqualifies a `WHERE` term from index use) over `INDEXED BY`.

## ON CONFLICT actions

These are the five algorithms invoked when an `INSERT` or `UPDATE` violates a
`UNIQUE`, `NOT NULL`, `CHECK`, or `PRIMARY KEY` constraint. The active
algorithm is, in order of precedence:

1. The `OR <action>` prefix on the current statement, if any.
2. The per-column `ON CONFLICT <action>` declared in `CREATE TABLE`.
3. `ABORT` (the global default).

`UPSERT`'s `DO UPDATE` always runs internally with `ABORT` regardless of
prefix or table default.

### ROLLBACK

* The current transaction is **immediately rolled back**.
* The statement returns `SQLITE_CONSTRAINT`.
* If there is no active explicit transaction, behaves the same as `ABORT`
  (the implicit per-statement transaction is what gets rolled back).
* Catastrophic from the client's point of view: all prior work in the
  transaction is lost.

### ABORT (default)

* The current statement **backs out its own prior changes** and returns
  `SQLITE_CONSTRAINT`.
* The enclosing transaction stays open; **changes made by earlier
  statements in the same transaction are preserved.**
* This is what most other RDBMSs do by default. Mapping to T-SQL: behaves
  like a normal constraint failure inside a multi-statement transaction —
  the offending statement is undone, but the transaction continues until the
  client decides to commit or roll back.

### FAIL

* Returns `SQLITE_CONSTRAINT`, but **does not back out partial changes** the
  statement has already made. Example: an `UPDATE` that hits a violation on
  row 100 leaves rows 1..99 updated and rows 100..N untouched.
* No rollback of the transaction.
* Rarely useful — almost always you want `ABORT` or `IGNORE`.

### IGNORE

* The offending row is silently **skipped**: not inserted, not updated.
* No error is returned; the statement continues processing further rows.
* Other rows before and after proceed normally.
* This is the closest analogue to "skip duplicates"; equivalent in spirit to
  T-SQL `INSERT ... WHERE NOT EXISTS (...)` style guards, but applied per
  row at constraint-check time.

### REPLACE

Only meaningful for **UNIQUE / PRIMARY KEY** violations:

* The pre-existing row(s) that collide are **deleted** to make room, then
  the new (or updated) row is written.
* `DELETE` triggers fire for the displaced rows.
* If `PRAGMA foreign_keys = ON`, FK cascades on those deletes run normally;
  an `ON DELETE RESTRICT` (or unsatisfiable `NO ACTION`) on a referencing
  child table will cause the operation to fail with an FK constraint error.
* No error is returned to the client on success; the command continues.

For **NOT NULL** violations encountered under `REPLACE`, the offending
column's `DEFAULT` is substituted; if there is no default, `REPLACE`
degrades to `ABORT`.

For **CHECK** and **FOREIGN KEY** violations, `REPLACE` behaves like
`ABORT` — it does not invent values to satisfy them.

### Triggers and conflict actions

Triggers are entered after the relevant constraint checks have been
scheduled. When a conflict action runs:

* `IGNORE`: any pending `BEFORE` triggers for the skipped row have already
  fired and have observed the attempted insert/update; subsequent `AFTER`
  triggers for that row do **not** fire.
* `REPLACE`: `BEFORE DELETE` and `AFTER DELETE` triggers fire for each
  displaced row, then the insert's own triggers fire normally for the new
  row.
* `ROLLBACK` / `ABORT` / `FAIL`: aborts the statement; any triggers that
  already ran on this row are not "un-fired" but their effects, like all
  other database changes since the statement began, are rolled back to the
  appropriate boundary.

## Views are read-only

`INSERT`, `UPDATE`, and `DELETE` are not directly allowed on views.
The supported pattern is to define `INSTEAD OF` triggers on the view; the
DML statement then fires the trigger, which performs whatever underlying
mutations are appropriate.

```sql
CREATE VIEW v AS SELECT id, a, b FROM t;
CREATE TRIGGER v_insert INSTEAD OF INSERT ON v
BEGIN
    INSERT INTO t(id, a, b) VALUES (NEW.id, NEW.a, NEW.b);
END;
```

This differs from T-SQL, where simple views are inherently updatable. When
emulating MSSQL DML against views in this server, every updatable view must
have a matching set of `INSTEAD OF` triggers.

## Identity / AUTOINCREMENT effects

* SQLite tables have an implicit 64-bit `rowid` unless `WITHOUT ROWID` is
  declared. A column declared `INTEGER PRIMARY KEY` becomes an alias for
  `rowid`.
* Without `AUTOINCREMENT`, an `INSERT` that omits the rowid picks the next
  unused value, which may reuse rowids freed by prior `DELETE`s.
* With `AUTOINCREMENT`, SQLite guarantees the next rowid is **strictly
  greater** than any rowid ever seen by that table — `sqlite_sequence` is
  consulted and updated on every insert.
* `REPLACE` / `INSERT OR REPLACE`: the displaced row's rowid is freed.
  Under `AUTOINCREMENT`, the freed rowid is **not** reused. Under plain
  `INTEGER PRIMARY KEY`, the freed rowid is eligible for reuse on a later
  insert that omits the key.
* `UPSERT`'s `DO UPDATE` preserves the existing row's rowid (it is an
  in-place update, not a delete+insert), making it the safest analogue of
  MSSQL `MERGE` when an `IDENTITY` column must remain stable.
