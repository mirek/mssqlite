# SQLite Query Optimizer and Indexes

This chapter is a tactical reference for building correct and fast queries on
top of SQLite. It covers the index model, the cost-based planner, the
EXPLAIN QUERY PLAN output language, and the high-impact rewrites the planner
applies (or fails to apply). When mapping MSSQL semantics onto SQLite, this is
what determines whether the resulting plan is sane.

## Index Basics

SQLite stores ordinary tables as a B-tree keyed by an integer `rowid`
(equivalent to `INTEGER PRIMARY KEY`). Rows are physically ordered by `rowid`.
A `WITHOUT ROWID` table replaces this with a B-tree keyed by the declared
PRIMARY KEY; everything below applies equally, with PRIMARY KEY columns
substituted for `rowid`.

There are four sources of indexes:

- **The implicit rowid B-tree** on every rowid table. Lookups by `rowid` or by
  `INTEGER PRIMARY KEY` are O(log N) binary searches against the table itself
  with no secondary lookup.
- **Internal indexes** named `sqlite_autoindex_<table>_<N>` automatically
  created to enforce `PRIMARY KEY` (on non-rowid PKs) and `UNIQUE`
  constraints. Persisted to disk, visible in `sqlite_schema`.
- **User-defined indexes** from `CREATE [UNIQUE] INDEX`. Each index is itself a
  B-tree of (indexed columns..., rowid) — the rowid is the tie-breaker, so
  every index entry is unique even when indexed columns repeat.
- **Automatic (query-time) indexes** built ephemerally during a single
  statement (see below). Despite the unfortunate naming overlap, these are
  unrelated to `sqlite_autoindex_*`.

Each table in a FROM clause uses **at most one index** per execution, except
when the OR-clause optimization splits the work across multiple indexes.

## Multi-Column Indexes and Left-Prefix Matching

For `CREATE INDEX idx ON t(a, b, c, d, e)`, the planner uses a contiguous
left prefix of the indexed columns:

- The initial columns must be constrained by `=`, `IN`, or `IS`.
- The rightmost used column may also use range operators (`>`, `>=`, `<`,
  `<=`, `BETWEEN`, prefix `LIKE`/`GLOB`). At most two inequalities sandwich it.
- **No gaps.** If column `c` is unconstrained, columns `d` and `e` cannot be
  used by the index — even if they have equality constraints.
- Columns to the right of an inequality column are not used for index search
  (skip-scan is the only exception, see below).

Examples for `INDEX(a,b,c,d,e,...)`:

```sql
WHERE a=5 AND b IN (1,2,3) AND c IS NULL AND d='x'  -- uses a,b,c,d
WHERE a=5 AND b IN (1,2,3) AND c>12 AND d='x'       -- uses a,b,c (d wasted)
WHERE a=5 AND b IN (1,2,3) AND d='x'                -- uses a,b   (gap at c)
WHERE b IN (1,2,3) AND c=4                          -- index NOT used (no a)
WHERE a=5 OR b=2                                    -- index NOT used (OR)
```

If two indexes exist where one is a strict prefix of the other, drop the
shorter one — the longer index handles both workloads.

## Covering Indexes

If every column the query references for a given table (both in the WHERE
clause and in the result columns) appears in the index, SQLite never visits
the table heap. EXPLAIN reports `USING COVERING INDEX`. This roughly halves
work versus a non-covering indexed lookup (one binary search instead of two).

```sql
CREATE INDEX idx_cover ON fruits(fruit, state, price);
SELECT price FROM fruits WHERE fruit='Orange' AND state='CA';
-- SEARCH fruits USING COVERING INDEX idx_cover (fruit=? AND state=?)
```

Adding "payload" columns to the right of the searched columns is the standard
way to engineer a covering index. The trailing columns do not need to
participate in the WHERE clause.

## DESC vs ASC, NULLS FIRST/LAST

Each indexed column may have `ASC` or `DESC`. SQLite can scan an index
forward or backward to satisfy `ORDER BY ... ASC` or `... DESC`, so a single
ASC index serves both a `SELECT ... ORDER BY x ASC` and `... ORDER BY x
DESC`. **Mixed ordering**, e.g. `ORDER BY a ASC, b DESC`, requires either an
index declared with that exact mix of directions, or a sort step.

`NULLS FIRST` / `NULLS LAST` interacts the same way: an index's null
positioning must match the ORDER BY for the sort to be elided. By default,
ASC sorts place NULLs first and DESC sorts place NULLs last; an explicit
`NULLS FIRST/LAST` in the ORDER BY that contradicts the index direction
forces a sort.

## Partial Indexes

A partial index has a `WHERE` clause and only indexes rows that satisfy it:

```sql
CREATE INDEX idx_open ON orders(customer_id) WHERE status='OPEN';
CREATE UNIQUE INDEX team_leader ON person(team_id) WHERE is_team_leader;
```

Benefits: smaller index, faster writes for rows outside the predicate, and
the `UNIQUE` form lets you enforce uniqueness over a subset of rows.

**Usability rules.** Let `X` be the index's WHERE expression and `W` the
query's WHERE expression. The index is usable when `W ⇒ X`. SQLite is not a
theorem prover — it applies only two simple rules:

1. If `W` is AND-connected and `X` is OR-connected (or a single term), and
   some term of `W` appears verbatim in `X`, the index is usable. Terms must
   match textually: `b=6` matches `6=b` (in the index, not the query) but
   does not match `b=3+3`, `b-6=0`, or `b BETWEEN 6 AND 6`.
2. If `X` contains `z IS NOT NULL` and `W` contains any comparison on `z`
   other than `IS` (i.e. `=`, `<`, `>`, `<=`, `>=`, `<>`, `IN`, `LIKE`,
   `GLOB`), the index is usable for that column — those operators
   short-circuit on NULL.

Anything more clever (algebra, range reasoning) is not done. Repeat the
index's predicate in the query if you want it picked up.

## Expression / Functional Indexes

```sql
CREATE INDEX idx_abs ON account_change(acct_no, abs(amt));
```

The planner uses the index only when the **exact same expression** appears in
the WHERE or ORDER BY clause. `WHERE y+x=22` does NOT match an index on
`(x+y)` — the planner does not commute or normalize expressions.

Restrictions:

- Expression refers only to columns of the indexed table.
- Functions must be deterministic. Application-defined functions need
  `SQLITE_DETERMINISTIC` at registration; otherwise they are rejected from
  CREATE INDEX.
- No subqueries in indexed expressions.
- Expressions are allowed only in `CREATE INDEX`, not in `UNIQUE` /
  `PRIMARY KEY` constraints inside `CREATE TABLE`.

**Stale expression indexes** are a real pitfall. If you redefine an
application function (different binding) or change a collation, expression
indexes built on it become semantically stale. Use `REINDEX EXPRESSIONS` (≥
3.53) to rebuild all expression indexes, or `REINDEX <name>` for a specific
one, or `REINDEX <collation>` for everything depending on a renamed
collation.

## ANALYZE and Statistics

`ANALYZE` walks indexes and writes summary statistics into `sqlite_stat1`
(and `sqlite_stat4` if SQLite was compiled with `SQLITE_ENABLE_STAT4`).
Without these stats, the planner uses constant guesses (default ~10
duplicates per left-most column), and many cost-based decisions degrade.

What the stats give the planner:

- `sqlite_stat1`: average duplicate count per index prefix. Enables the
  planner to compare selectivity across competing indexes and to choose
  join order.
- `sqlite_stat4`: per-column histograms (left-most plus all subsequent
  columns). Enables informed cost estimates for **range** predicates
  (`x BETWEEN ...`) and for `=`/`IN` against compile-time-constant or bound
  parameter values. Not built by approximate ANALYZE.

```sql
ANALYZE;                      -- analyze everything
ANALYZE main;                 -- one schema
ANALYZE orders;               -- one table + its indexes
ANALYZE idx_orders_customer;  -- one index
```

Statistics are loaded into memory when the schema is read. If you `UPDATE`
the stat tables directly (rare, for query-plan stability), run `ANALYZE
sqlite_schema` to force a reload.

### PRAGMA optimize

Preferred recurring entry point. Usually a no-op; runs ANALYZE only on
tables that need it. As of 3.46.0 it automatically constrains its own
scope, so it stays fast even on huge databases.

Recommended pattern:

```sql
PRAGMA optimize=0x10002;  -- on connection open (long-lived connections)
PRAGMA optimize;          -- periodic, and before connection close
```

The `0x10000` bit (`=0x10002` combines it with the default `0x00002`) forces
examination of all tables, not only ones queried by the current connection
— useful at startup when there is no query history yet.

Always run `PRAGMA optimize` after `CREATE INDEX` or other schema changes.

### analysis_limit

For full `ANALYZE` on very large databases:

```sql
PRAGMA analysis_limit=1000;
ANALYZE;
```

Limits per-index row visits to roughly N (100–1000 is the recommended
range; 0 disables the limit). The results are approximations but usually
good enough. Approximate ANALYZE does NOT populate `sqlite_stat4`.

### Frozen stats (query-plan stability)

For applications that need identical plans in production as in test, run
ANALYZE once during development and bake the result into a one-shot
initialization script:

```sql
SELECT 'ANALYZE sqlite_schema;DELETE FROM sqlite_stat1;'
    || 'INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES'
    || (SELECT group_concat(format('(%Q,%Q,%Q)',tbl,idx,stat),',')
          FROM sqlite_stat1)
    || ';ANALYZE sqlite_schema;';
```

Combine with the Query Planner Stability Guarantee
(`SQLITE_DBCONFIG_ENABLE_QPSG`) to lock plans.

## How the Planner Works

SQLite implements every join as a sequence of nested loops, one per FROM
table. For each loop the planner picks at most one index. The planning
problem decomposes into:

1. Pick the nesting order.
2. Pick an index for each loop.

The current ("NGQP") planner uses an `N` nearest-neighbors graph algorithm
that runs in polynomial time, so 50–60-way joins plan in microseconds. It
estimates per-loop "setup" cost, per-step cost, output row count, and
sorting cost, then minimizes a logarithmic aggregate cost.

Default loop ordering puts the leftmost FROM table outermost, but the
planner reorders freely when that yields better indexes. **Exceptions**:

- `CROSS JOIN` is never reordered — useful as a manual hint.
- Outer joins (`LEFT`, `RIGHT`, `FULL`) are not commutative; their position
  is fixed. Inner joins flanking an outer join may still be reordered.

ON-clause and USING-clause constraints are normalized into the WHERE clause
internally (with tags retained for outer joins), so all WHERE/ON analysis
applies uniformly.

## WHERE-Clause Term Forms the Planner Recognizes

The planner can use the following term shapes against an index:

```
column = expression           column IS expression
column > expression           column >= expression
column < expression           column <= expression
column IN (list | subquery)   column IS NULL
column LIKE pattern           column GLOB pattern
BETWEEN (rewritten to >= AND <=)
```

`BETWEEN x AND y` becomes two virtual terms (`col >= x AND col <= y`). If
both are consumed by an index, the original `BETWEEN` is dropped (no
re-test on each row).

## OR-Clause Optimizations

Two strategies:

1. **OR → IN.** If all OR terms equate the same column to expressions, the
   planner rewrites them as `IN`:
   ```
   col=1 OR col=2 OR col=3   →   col IN (1,2,3)
   ```
   The IN then constrains an index normally.

2. **OR by UNION.** If every subterm of an OR clause is independently
   indexable, the planner uses a different index per subterm and unions
   the resulting rowid sets. EXPLAIN shows this as `MULTI-INDEX OR`. If even
   one subterm has no index, the planner falls back to a single full scan.

This is the only case in which a single table uses more than one index.

## LIKE / GLOB Optimization

A `col LIKE 'prefix%'` becomes `col >= 'prefix' AND col < 'prefiq'` (two
virtual range terms) that can drive an index — IF all of the following hold:

- RHS is a string literal (or bound parameter via `sqlite3_prepare_v2`) that
  does **not** start with a wildcard.
- Either the column has TEXT affinity, or the pattern doesn't start with `-`
  or a digit (numerics break lexicographic ordering: `'9' > '10'`).
- The `like()` / `glob()` SQL functions have not been replaced.
- For `GLOB`: the column must use the BINARY collation.
- For `LIKE`:
  - If `PRAGMA case_sensitive_like=ON`, column must use BINARY collation.
  - If `case_sensitive_like=OFF` (the default), column must use NOCASE
    collation.

If the pattern is `prefix%` with a single trailing wildcard, the LIKE test
itself is dropped after the index is consulted; otherwise the original LIKE
is still re-tested per row.

When the RHS is a bound parameter, statements prepared with
`sqlite3_prepare_v2` are automatically re-prepared if the binding changes
between executions, so the optimizer can re-evaluate whether the
optimization applies.

## Skip-Scan

If the leftmost columns of an index have very few distinct values and only
trailing columns are constrained, the planner may "skip-scan" — iterate the
distinct leading values and, for each, do an indexed lookup on the rest.

```sql
CREATE INDEX people_idx ON people(role, height);
SELECT name FROM people WHERE height >= 180;
-- SEARCH people USING INDEX people_idx (ANY(role) AND height>?)
```

Only profitable when the leading column has ≳18 duplicates per value, and
SQLite only knows that from ANALYZE. Skip-scan is **never** used on
un-analyzed databases.

## Choosing Between Multiple Indexes

When several indexes could serve a single table, the planner picks the one
with the lowest estimated cost. With `sqlite_stat1`, this is selectivity-
driven; without it, the choice is arbitrary. For range predicates against
non-leftmost columns, only `sqlite_stat4` (full ANALYZE) gives the planner
the histogram data needed to distinguish them.

## ORDER BY, GROUP BY, DISTINCT via Index

If the natural row order produced by the chosen loop matches the requested
ORDER BY, the sort step is elided. Same for GROUP BY and DISTINCT — they
collapse to "is this row equal to the previous row?" when the matching
columns arrive in order. EXPLAIN shows either `SCAN ... USING INDEX <i>` (no
sort) or `USE TEMP B-TREE FOR ORDER BY` / `GROUP BY` / `DISTINCT` (sort
required).

**Search + sort with one index.** Equality WHERE clauses on the index's left
columns make the matching rows contiguous; remaining index columns then
provide the ORDER BY ordering. Best case is a single covering index:

```sql
CREATE INDEX i ON fruits(fruit, state, price);
SELECT * FROM fruits WHERE fruit='Orange' ORDER BY state;
-- one indexed range, no sort, no heap lookup
```

**Block (partial) sort.** When an index supplies only a prefix of the
ORDER BY, SQLite breaks the output into runs aligned with the prefix and
sorts each run independently. Less memory, supports early row delivery,
plays well with LIMIT. Always preferred over a full sort when possible.

**MIN/MAX optimization.** `SELECT MIN(x) FROM t` and `SELECT MAX(x) FROM t`
turn into one index lookup when `x` is the leftmost column of an index.

## Subqueries: Flatten, Co-routine, Materialize

For a subquery in the FROM clause, SQLite picks one of three strategies:

1. **Flatten** the subquery into the outer query (rewrite as a single
   join). Subject to a long list of restrictions; commonly defeated by
   `DISTINCT`, `LIMIT`, `ORDER BY`, aggregates, window functions, and
   certain compound queries.
2. **Co-routine** the subquery — run it in lockstep with the outer query,
   yielding one row at a time. Low memory, allows early output, supports
   LIMIT short-circuiting. Used when the subquery feeds the outer query
   exactly once.
3. **Materialize** into a transient table. Needed when the subquery would
   be scanned more than once (e.g. inside a join). EXPLAIN shows
   `MATERIALIZE x` plus a follow-up `SCAN x` / `SEARCH x`.

### Predicate push-down

When a subquery cannot be flattened, the planner may still push WHERE
terms from the outer query down into the subquery to shrink it:

```sql
CREATE VIEW v1(a,b) AS SELECT DISTINCT a,b FROM t1;
SELECT x,y,b FROM t2 JOIN v1 ON x=a WHERE b BETWEEN 10 AND 20;
-- b BETWEEN 10 AND 20 is pushed into the v1 subquery
```

Push-down is blocked when it would change semantics — most notably across
`LIMIT`, certain window-function arrangements, and outer-join boundaries.

(Not to be confused with the MySQL push-down optimization, which reorders
index-only predicates. SQLite does that too — it just calls it something
else.)

### LIMIT-deferred work via co-routine

Wrap expensive output expressions in an outer query over a subquery that
ORDER BYs and LIMITs first; the planner uses a co-routine so the expensive
function runs only on the surviving rows:

```sql
-- bad: expensive_function() runs on every row
SELECT expensive_function(a) FROM tab ORDER BY date DESC LIMIT 5;

-- good: expensive_function() runs on 5 rows
SELECT expensive_function(a) FROM (
  SELECT a FROM tab ORDER BY date DESC LIMIT 5
);
```

## Constant Propagation

Given `WHERE a=b AND b=5` (matching affinities), the planner infers `a=5`
and can use an index on `a`. Affinities must agree, or the inference is
unsafe.

## OUTER JOIN Strength Reduction and Elimination

- A LEFT/RIGHT/FULL JOIN demotes to an inner/left/right JOIN if the WHERE
  clause guarantees a non-NULL match on the optional side.
- A LEFT JOIN is dropped entirely if (a) the query is not an aggregate,
  (b) the join condition matches at most one row OR the query is DISTINCT,
  and (c) no column from the right side is referenced anywhere else.

Common when LEFT JOINs come from views whose right side isn't projected by
the caller.

## Automatic (Query-Time) Indexes

When a join uses an unindexed equi-join column, SQLite may build a transient
B-tree for the duration of the statement — effectively a hash-join, but with
a B-tree instead of a hash table. Trigger condition: estimated lookups
exceed log N.

```sql
SELECT * FROM t1, t2 WHERE t1.a = t2.c;  -- and neither side has an index
```

EXPLAIN shows `USING AUTOMATIC COVERING INDEX`. Every such occurrence emits
an `SQLITE_WARNING_AUTOINDEX` to the error log — treat these as signals to
add a persistent index. Toggle with `PRAGMA automatic_index = ON/OFF`.

Distinct from `sqlite_autoindex_*`, which are persistent indexes created to
back `UNIQUE`/`PRIMARY KEY` constraints. Same word, different concept.

## Reading EXPLAIN QUERY PLAN

```sql
EXPLAIN QUERY PLAN SELECT ...;
```

The output is a tree of records, one per data access. The CLI renders it as
ASCII art; `.eqp on` makes it automatic, `.explain off` switches to tabular.
The format is **not stable** between releases — for debugging only.

Per-table records start with either `SCAN` or `SEARCH`:

- `SCAN t` — full-table scan, no index lookup. Visits every row.
- `SCAN t USING INDEX i` — full index scan; still visits every row but
  in index order (typically to satisfy ORDER BY/GROUP BY).
- `SCAN t USING COVERING INDEX i` — full index scan, no heap lookup.
- `SEARCH t USING INDEX i (a=?)` — indexed range/equality lookup.
- `SEARCH t USING COVERING INDEX i (a=? AND b>?)` — same, no heap visit.
- `SEARCH t USING INTEGER PRIMARY KEY (rowid=?)` — direct rowid binary
  search.
- `SEARCH t USING AUTOMATIC COVERING INDEX (...)` — ephemeral index built
  during the query. Add a persistent index.

The parenthesized clause shows which WHERE terms drove the index — `(a=? AND
b>?)` tells you `a` is equality-matched and `b` is the range column. If a
WHERE term you expected to be used is absent here, the planner did not use
it as an index constraint.

Nesting order: in a join, records appear outer-loop-first. The FROM clause
order doesn't dictate it; the planner reorders.

```
sqlite> EXPLAIN QUERY PLAN SELECT t1.*, t2.* FROM t1, t2 WHERE t1.a=1 AND t1.b>2;
|--SEARCH t1 USING INDEX i2 (a=? AND b>?)
`--SCAN t2
-- t1 is outer (driver), t2 is inner (re-scanned per t1 row).
```

Other markers:

- `USE TEMP B-TREE FOR ORDER BY / GROUP BY / DISTINCT` — explicit sort step.
  Add or extend an index to avoid it.
- `MULTI-INDEX OR` with two `SEARCH` children — OR-by-UNION optimization
  using two indexes on the same table.
- `SCALAR SUBQUERY` — constant subquery, computed once.
- `CORRELATED SCALAR SUBQUERY` — depends on outer row, runs once per outer
  row.
- `CO-ROUTINE <alias>` — FROM-clause subquery executed lockstep with the
  outer query.
- `MATERIALIZE <alias>` — FROM-clause subquery dumped to a transient table.
- `COMPOUND QUERY` + `LEFT-MOST SUBQUERY` + `UNION USING TEMP B-TREE` —
  set operation via a temp b-tree.
- `MERGE (EXCEPT|INTERSECT|UNION)` — sorted-merge alternative, used when
  outputs are already ordered.

## INDEXED BY / NOT INDEXED

```sql
SELECT * FROM t INDEXED BY idx WHERE ...;
SELECT * FROM t NOT INDEXED WHERE ...;
```

- `INDEXED BY idx` is a **requirement**, not a hint. If the named index
  cannot serve the query, statement preparation fails.
- `NOT INDEXED` forbids all indexes (including those backing UNIQUE/PRIMARY
  KEY constraints), but rowid lookups still work.

These exist primarily to **detect** regressions: a schema change that
invalidates the chosen index will turn a runtime error rather than silently
shift the plan. They are not a performance-tuning tool. For real plan
control, use:

- The unary `+` operator on a column to disqualify a single WHERE term from
  index use (also strips affinity — watch for semantic changes when the
  column is TEXT-affinity but compared to a number).
- `CROSS JOIN` to pin loop nesting order.
- `sqlite3_stmt_status(SQLITE_STMTSTATUS_FULLSCAN_STEP /
  STMTSTATUS_SORT)` for runtime detection of bad plans.

## Quick Checklist for Bad Plans

1. Has `ANALYZE` been run? Run `PRAGMA optimize` and re-check.
2. Is the WHERE term in a form the planner recognizes (left side bare
   column, supported operator)? If not, rewrite.
3. For expression indexes: does the query use the **exact same** expression
   text as the index?
4. For partial indexes: does the query's WHERE contain the partial index's
   WHERE term verbatim (or an operator that implies non-NULL)?
5. Does the index column ordering match the actual WHERE-prefix used by
   the query? Reorder columns or add a new index.
6. Is the column subset wide enough for a covering index? Adding payload
   columns to the right of the index roughly halves cost.
7. Is `USE TEMP B-TREE FOR ORDER BY` showing up? Extend an existing index
   with the ORDER BY columns appended.
8. Is `USING AUTOMATIC COVERING INDEX` showing up, or
   `SQLITE_WARNING_AUTOINDEX` in the error log? Persist it as a real index.
9. For LIKE: is the column collation BINARY (or NOCASE if
   `case_sensitive_like=OFF`)? Without the right collation, LIKE cannot use
   an index even with a non-wildcard prefix.
10. As a last resort: `CROSS JOIN` to fix join order, unary `+` to suppress
    a misleading WHERE term, or hand-tune `sqlite_stat1`. Then file a bug.
