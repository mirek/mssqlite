# SQLite Queries Reference

This chapter is a parser/planner-oriented reference for SQLite query
constructs (SELECT and friends). It is the source of truth when emulating
an MSSQL TDS front-end on top of SQLite: every shape of statement listed
here must round-trip through the proxy unchanged or be rewritten into one
of these shapes. Behaviours that diverge from standard SQL are called out
explicitly because the T-SQL front-end may need to compensate.

## Overall SELECT grammar

A top-level `select-stmt` is built from `select-core` clauses joined by
compound operators, optionally prefixed by `WITH` and suffixed by
`ORDER BY`, `LIMIT`/`OFFSET`:

```ebnf
select-stmt ::=
    [ WITH [RECURSIVE] cte ("," cte)* ]
    select-core ( compound-operator select-core )*
    [ ORDER BY ordering-term ("," ordering-term)* ]
    [ LIMIT expr [ ( OFFSET | "," ) expr ] ]

select-core ::=
      SELECT [DISTINCT|ALL] result-column ("," result-column)*
      [ FROM table-or-subquery ("," table-or-subquery)* | join-clause ]
      [ WHERE expr ]
      [ GROUP BY expr ("," expr)* [ HAVING expr ] ]
      [ WINDOW window-name AS window-defn ("," window-name AS window-defn)* ]
    | VALUES "(" expr ("," expr)* ")" ("," "(" expr ("," expr)* ")")*

compound-operator ::= UNION | UNION ALL | INTERSECT | EXCEPT
```

The four logical processing steps for a simple SELECT are: FROM, WHERE,
GROUP BY/HAVING/result-column, then DISTINCT/ALL.

## SELECT clause (result columns)

```ebnf
result-column ::= expr [ [AS] column-alias ]
                | "*"
                | table-name "." "*"
```

- `*` expands to all columns of the joined input. `table.*` (or
  `alias.*`) expands to all columns from that named table/subquery.
- `*` and `alias.*` are illegal outside a result-column list, and also
  illegal in a SELECT that has no FROM clause.
- `AS` keyword is optional; `SELECT a b FROM t` aliases column `a` as
  `b`. The column-alias is visible to `ORDER BY` (by name or ordinal)
  but not, in general, to `WHERE`/`GROUP BY`/`HAVING`.
- `DISTINCT` removes duplicate result rows after the result expressions
  are computed. Comparisons use `IS DISTINCT FROM` (so two NULLs are
  equal; integers and floats compare numerically; text uses the column's
  collation; BLOB affinity is used so no type coercion happens).
- `ALL` is the default and may be written explicitly.

A SELECT with no FROM produces exactly one row of zero columns from the
inputs (so `SELECT 1+1` returns one row, one column).

## FROM clause

```ebnf
table-or-subquery ::=
      [ schema-name "." ] table-name [ [AS] table-alias ]
            [ INDEXED BY index-name | NOT INDEXED ]
    | [ schema-name "." ] table-function-name "(" [ expr ("," expr)* ] ")"
            [ [AS] table-alias ]
    | "(" select-stmt ")" [ [AS] table-alias ]
    | "(" table-or-subquery ("," table-or-subquery)* | join-clause ")"
```

- Multiple comma-separated `table-or-subquery` entries form a comma
  join (cartesian product, no constraint).
- A parenthesised `select-stmt` is a derived table; each output column
  inherits the collation and affinity of its source expression.
- `INDEXED BY`/`NOT INDEXED` are SQLite-specific planner hints.
- Table-valued functions in FROM are virtual tables with hidden
  columns: the function arguments become constraints on those hidden
  columns. Common ones: `json_each`, `json_tree`, `generate_series`
  (when compiled in), FTS5 vtabs, `pragma_*` table-valued PRAGMAs.

A bare reference can also be a CTE name (see WITH below) — CTEs act as
temporary views for the duration of the statement.

## JOIN clause and join semantics

```ebnf
join-clause     ::= table-or-subquery ( join-operator table-or-subquery [ join-constraint ] )+
join-operator   ::= ","
                  | [NATURAL] [LEFT|RIGHT|FULL] [OUTER] JOIN
                  | [NATURAL] INNER JOIN
                  | CROSS JOIN
join-constraint ::= ON expr | USING "(" column-name ("," column-name)* ")"
```

Semantics (every join starts from the cartesian product of the left and
right inputs, then is filtered):

| Operator | Behaviour |
|---|---|
| `,`, `JOIN`, `INNER JOIN`, `CROSS JOIN` | Cartesian product; if there is an `ON`/`USING` clause, only rows where it evaluates to true are kept. With no constraint the result is the full cross product. |
| `LEFT [OUTER] JOIN` | After ON/USING filtering, add one all-NULL-extended row for each left-side row that matched nothing on the right. |
| `RIGHT [OUTER] JOIN` | Mirror of LEFT JOIN: add a NULL-extended row for each unmatched right-side row. |
| `FULL [OUTER] JOIN` | Both LEFT and RIGHT behaviours combined. |
| `NATURAL ...` | An implicit `USING (c1, c2, ...)` is added covering every column name that appears in both inputs. If there is no common column the NATURAL keyword is a no-op. ON/USING cannot be combined with NATURAL. |

`USING (c)` collapses the two `c` columns into one (the right-hand copy
is dropped from the output); `ON lhs.c = rhs.c` keeps both. Apart from
that one difference, the two are equivalent for matching.

`CROSS JOIN` is the same as INNER JOIN semantically, but the optimizer
will not reorder its operands: it is a manual hint to lock in join
order. This is SQLite-specific.

Multiple joins associate left-to-right: `A op1 B op2 C` is
`((A op1 B) op2 C)`. Note that **all** join operators (including comma)
have the same precedence in SQLite — standard SQL gives `JOIN` higher
precedence than `,`, so `FROM t1, t2 NATURAL FULL JOIN t3` differs from
the standard. Workaround: do not mix commas with `JOIN`, and use
explicit parentheses if in doubt.

`RIGHT JOIN` and `FULL JOIN` were added in SQLite 3.39.0 (2022-09-29);
older builds will reject those tokens.

Quirky inputs that SQLite still accepts (avoid emitting them):

- Combinations like `LEFT RIGHT JOIN` (treated as FULL),
  `OUTER LEFT NATURAL JOIN` (same as NATURAL LEFT OUTER JOIN). Any
  1–3 of `CROSS FULL INNER LEFT NATURAL OUTER RIGHT` before `JOIN` are
  parsed as a set of flags.
- `ON`/`USING` attached to a comma or CROSS JOIN.
- An outer join with no `ON`/`USING` (degenerates to inner join).

### WHERE vs ON for outer joins

For inner/cross/comma joins there is no observable difference between a
predicate placed in `WHERE` and one in `ON`. For outer joins the
distinction is critical: `ON` is evaluated before the NULL-extension
step, so a predicate like `ON l.x = r.y` still produces an all-NULL
right side for unmatched left rows. The same predicate in `WHERE` is
applied after NULL extension, and a NULL on either side will exclude
the row — effectively converting the join back to an inner join.

## WHERE clause

```ebnf
WHERE expr
```

`expr` is evaluated as a boolean for every candidate row; rows are kept
only when the expression is true. NULL (unknown) and false both filter
the row out. Predicates may reference any column of any table in FROM,
correlated subqueries, scalar functions, `EXISTS (subquery)`,
`expr IN (subquery)`, `IN (val, val, ...)`, `BETWEEN`,
`LIKE`/`GLOB`/`REGEXP`/`MATCH`, `IS [NOT] NULL`, `IS [NOT] DISTINCT FROM`,
`IS [NOT] <value>`, row-value comparisons (see below) and CASE.

## GROUP BY / HAVING

```ebnf
GROUP BY expr ("," expr)* [ HAVING expr ]
```

- A query is an *aggregate* query if it contains either a `GROUP BY`
  clause or any aggregate function in its result-set/HAVING.
- Each `GROUP BY` expression is evaluated for every filtered row.
  Rows with equal values for every GROUP BY expression land in the
  same group; NULLs compare equal for grouping purposes; text uses the
  normal collation rules.
- GROUP BY expressions need not appear in the result list and may be
  arbitrary expressions, but they may not themselves be aggregates.
- Like ORDER BY, a `GROUP BY` term that is a plain integer constant `K`
  is interpreted as the K-th result column (1-based); a bare identifier
  matching a result-column alias also refers to that column.
- `HAVING` runs once per group as a boolean; the group is kept only if
  HAVING evaluates to true. HAVING may reference aggregates and may
  reference values that are not in the result. A non-aggregate term in
  HAVING is evaluated against an arbitrary row of the group.
- Aggregates may take an optional `DISTINCT` and/or `ORDER BY` inside
  the call: `group_concat(DISTINCT x ORDER BY y, ',')`.
- Aggregates may also have a `FILTER (WHERE expr)` clause that limits
  which rows feed into the aggregate.

### Bare columns (SQLite extension)

A "bare column" is a column reference in the result-set that is neither
inside an aggregate nor in the GROUP BY. SQLite allows this where most
other engines reject it.

- For an arbitrary bare column, the value comes from an arbitrary input
  row of the group — do not depend on which one.
- Exception: if the query contains exactly one `min()` or `max()`
  aggregate, bare columns are pulled from the row that produced the
  min/max. This applies only to the built-in min/max — user-defined
  overrides do not get the special treatment. Ties are resolved
  arbitrarily.

When proxying T-SQL, you must reject (or compensate for) bare columns
since SQL Server enforces the "every non-aggregate must appear in
GROUP BY" rule.

### Aggregate query without GROUP BY

An aggregate query without GROUP BY always returns exactly one row,
even over zero input rows. Aggregates are computed over the whole
filtered set; bare columns get an arbitrary row's value, or NULL if
the input is empty.

## ORDER BY

```ebnf
ordering-term ::= expr [ COLLATE collation-name ] [ ASC | DESC ] [ NULLS ( FIRST | LAST ) ]
```

- Default direction is `ASC`. NULLs sort below all non-NULL values, so
  by default `ASC` puts NULLs first and `DESC` puts them last; use
  `NULLS FIRST`/`NULLS LAST` to override.
- A pure integer literal `K` refers to the K-th result column
  (1-based). An identifier that matches a result-column alias refers
  to that column.
- Any other expression is computed per row and used for ordering. In a
  simple SELECT the expression may be arbitrary; in a compound SELECT
  an ORDER BY expression that is not an integer alias must match a
  result-column expression of one of the legs exactly.
- Collation precedence for an ORDER BY term: explicit `COLLATE` on the
  term wins; otherwise the collation of the aliased expression (if it
  used `COLLATE`); otherwise the column's default collation; otherwise
  `BINARY`.
- In a compound select, only the right-most simple SELECT may carry
  the ORDER BY, and it sorts the whole compound. If the right-most leg
  is a VALUES clause, no ORDER BY is allowed.

## LIMIT and OFFSET

```ebnf
LIMIT expr                       -- N rows
LIMIT expr OFFSET expr           -- offset M, then N rows
LIMIT expr1 "," expr2            -- LEGACY: M = expr1, N = expr2  (offset comma is reversed!)
```

- Negative `LIMIT` means no upper bound. Negative `OFFSET` is treated
  as zero. Both must evaluate to integers (or be losslessly
  convertible); NULL is an error.
- The `LIMIT m, n` short form is supported for MySQL compatibility but
  swaps the order: `m` is the offset and `n` is the limit. Prefer the
  `LIMIT n OFFSET m` form.
- In a compound SELECT only the right-most leg may carry a LIMIT, and
  the LIMIT applies to the whole compound. Not allowed if the
  right-most leg is a VALUES.
- `LIMIT x OFFSET y` is computed as "compute first `x+y` rows then
  discard the first `y`"; cost grows with `y`. For deep paging prefer
  a row-value seek (`WHERE (k1,k2) > (?,?) ORDER BY k1,k2 LIMIT n`).

## Compound SELECTs

```ebnf
select-core ( ( UNION [ALL] | INTERSECT | EXCEPT ) select-core )*
```

- All legs must produce the same number of result columns. They are
  matched positionally; the result columns take the names of the
  left-most leg.
- Legs cannot have their own ORDER BY/LIMIT — these apply only to the
  whole compound, attached at the end, and only if the last leg is not
  a `VALUES`.
- `UNION ALL` — concatenation, duplicates preserved.
- `UNION` — concatenation, duplicates removed.
- `INTERSECT` — rows that appear in both, duplicates removed.
- `EXCEPT` — rows from the left not in the right, duplicates removed.
- Duplicate detection in UNION/INTERSECT/EXCEPT treats NULL as equal to
  NULL and unequal to anything else. No affinity conversions are
  applied across legs; text values compare with the equality collation
  rules (postfix `COLLATE` does not get extra precedence here).
- Left-associative: `A op B op C` ≡ `(A op B) op C`.
- The number of legs is capped by `SQLITE_LIMIT_COMPOUND_SELECT`
  (default 500).

## Subqueries

Subqueries can appear in four positions:

- **In FROM** — a derived table; column collations/affinities propagate
  from the inner SELECT.
- **As scalar expressions** — `(SELECT ...)` returning at most one row
  and one column. If the subquery returns no rows the value is NULL; if
  it returns multiple rows, only the first row encountered is used.
- **Inside `IN`/`NOT IN`** — `expr IN (SELECT ...)` matches any value
  returned by the subquery. NULL handling follows standard
  three-valued logic.
- **Inside `EXISTS`/`NOT EXISTS`** — `EXISTS (SELECT ...)` is true iff
  the subquery would return at least one row.

Subqueries may be correlated: they may reference columns of the
enclosing FROM. Correlated subqueries cost roughly one execution per
outer row but SQLite's optimiser will often unflatten them (see CTE
materialization hints below).

## Row-value expressions (tuples)

A row value is a parenthesised list of two or more scalars (a vector).
Available since SQLite 3.15.0.

- Two row values of the same size may be compared with `<`, `<=`, `>`,
  `>=`, `=`, `<>`, `IS`, `IS NOT`, `IN`, `NOT IN`, `BETWEEN`, and
  inside `CASE`.
- Comparison is left-to-right (lexicographic). The overall result is
  NULL if any component is NULL *and* the outcome would change
  depending on what the NULL stood for; otherwise the result is
  decisive even with NULLs.
- A subquery that produces N≥2 result columns is a row value. A
  one-column subquery is just a scalar.
- For `IN`, the right-hand side must be a subquery: the LHS may be
  either a parenthesised list of scalars or a multi-column subquery,
  but `... IN ((1,2), (3,4))` is *not* valid syntax.
- In `UPDATE`, the SET clause may set a row value:
  `UPDATE t SET (a,b,c) = (SELECT x,y,z FROM ... WHERE ...)`. The LHS
  is a list of column names.

Useful idioms:

```sql
-- Keyset pagination (much cheaper than OFFSET on large tables):
SELECT * FROM contacts
 WHERE (lastname, firstname) > (?1, ?2)
 ORDER BY lastname, firstname
 LIMIT 7;

-- Multi-column IN against another query:
SELECT ordid, prodid, qty FROM item
 WHERE (prodid, qty) IN (SELECT prodid, qty FROM item WHERE ordid = 365);

-- Date stored as three columns:
SELECT * FROM info
 WHERE (year, month, day) BETWEEN (2015,9,12) AND (2016,9,12);
```

## VALUES clause as a row source

```ebnf
VALUES "(" expr ("," expr)* ")" ("," "(" expr ("," expr)* ")")*
```

`VALUES (e1, ..., eN)` is exactly equivalent to `SELECT e1, ..., eN`.
A multi-row `VALUES` is equivalent to a `UNION ALL` of single-row
SELECTs, but is not constrained by `SQLITE_LIMIT_COMPOUND_SELECT`.
Restrictions: cannot be followed by ORDER BY or LIMIT. Column names of
a VALUES are `column1`, `column2`, ... unless an outer alias supplies
names.

VALUES is commonly used as a synthetic table in CTEs and INSERTs:

```sql
WITH letters(c, n) AS (VALUES ('a',1), ('b',2), ('c',3))
SELECT * FROM letters;
```

## Common Table Expressions (`WITH`)

```ebnf
with-clause ::= WITH [RECURSIVE] cte ("," cte)*
cte         ::= table-name [ "(" column-name ("," column-name)* ")" ]
                AS [ NOT MATERIALIZED | MATERIALIZED ] "(" select-stmt ")"
```

`WITH` may prefix a SELECT, INSERT, UPDATE, or DELETE. A single WITH
clause may define both ordinary and recursive CTEs. The `RECURSIVE`
keyword is optional in SQLite (standard SQL requires it); its presence
does not force any CTE to be recursive.

### Ordinary CTEs

An ordinary CTE acts as a view scoped to the statement, useful for
factoring out subqueries.

### Recursive CTEs

A recursive CTE has these requirements:

- The body must be a *compound* SELECT (≥ 2 legs) joined by `UNION` or
  `UNION ALL` (and only those — `INTERSECT`/`EXCEPT` are not allowed
  to separate the recursive/anchor legs).
- At least one leg must be *recursive*: its FROM clause references the
  CTE name exactly once. At least one leg must be *non-recursive*
  (the anchor).
- All non-recursive (anchor) legs come first, then all recursive legs.
- All legs in the recursive group must be separated by the same
  operator (either all UNION or all UNION ALL) that joins anchor to
  recursive.
- Recursive legs may not use aggregate or window functions.
- The recursive leg may itself be a compound (since 3.34.0) and may
  carry ORDER BY/LIMIT/OFFSET; the anchor may not.
- Recursive CTE references inside subqueries of the recursive leg are
  not allowed — the recursive table name may appear only once, at the
  top level of the recursive leg's FROM clause.

Algorithm:

1. Run the anchor; push its rows onto a queue.
2. While the queue is non-empty: pop a row, add it to the CTE result,
   and run the recursive leg pretending the popped row is the entire
   CTE so far; push results back onto the queue.
3. With `UNION`, duplicates are discarded before being added to the
   queue (NULLs compare equal). With `UNION ALL`, all rows are added.
4. An ORDER BY on the recursive leg controls the order rows are pulled
   from the queue (priority queue) — this is how depth-first vs
   breadth-first traversal is controlled. Default (no ORDER BY) is
   FIFO, i.e. breadth-first.
5. A LIMIT on the recursive leg hard-caps the CTE size; OFFSET skips
   the first N rows from being *added* to the CTE result (they are
   still expanded by the recursive step).

Canonical shape:

```sql
WITH RECURSIVE
  cnt(x) AS (
    VALUES(1)                               -- anchor
    UNION ALL
    SELECT x+1 FROM cnt WHERE x < 1000000   -- recursive
  )
SELECT x FROM cnt;
```

Tree traversal with depth-first/breadth-first control:

```sql
WITH RECURSIVE
  under_alice(name, level) AS (
    VALUES('Alice', 0)
    UNION ALL
    SELECT org.name, under_alice.level + 1
      FROM org JOIN under_alice ON org.boss = under_alice.name
     ORDER BY 2          -- breadth-first; "ORDER BY 2 DESC" makes it depth-first
  )
SELECT * FROM under_alice;
```

Graph (cycle-safe) using `UNION` to dedupe:

```sql
WITH RECURSIVE nodes(x) AS (
  SELECT 59
  UNION
  SELECT aa FROM edge JOIN nodes ON bb = x
  UNION
  SELECT bb FROM edge JOIN nodes ON aa = x
)
SELECT x FROM nodes;
```

### Materialization hints

`AS MATERIALIZED` and `AS NOT MATERIALIZED` after the CTE name are
non-standard (Postgres-borrowed) hints, available since SQLite 3.35.0:

- `MATERIALIZED` — force evaluating the CTE into an ephemeral table
  once and reusing it. Acts as an optimisation fence (disables
  flattening, push-down).
- `NOT MATERIALIZED` — inline the CTE wherever it is referenced (like
  a view/subquery). The planner is still free to materialise.
- Omitted — planner decides; this is the recommended default.

### Limitations

- `WITH` is not allowed inside `CREATE TRIGGER`.
- `WITH` must be at the start of a top-level SELECT or at the start of
  a subquery; it cannot be attached to the second-or-later leg of a
  compound SELECT.

## Window functions

A window function call:

```ebnf
window-function-invocation ::=
    window-func "(" [ expr ("," expr)* | "*" ] ")"
        [ FILTER "(" WHERE expr ")" ]
        OVER ( window-name | window-defn )

window-defn ::= "(" [ base-window-name ]
                    [ PARTITION BY expr ("," expr)* ]
                    [ ORDER BY ordering-term ("," ordering-term)* ]
                    [ frame-spec ]
                ")"
```

A function is a window function iff it has an `OVER` clause. A FILTER
clause may appear before OVER and limits which rows feed into the
window for that row's frame. Window functions do *not* collapse rows —
the SELECT still returns one row per input row.

Named windows are declared in the SELECT-level `WINDOW` clause and
referred to by name from `OVER`:

```sql
SELECT a, rank() OVER w, row_number() OVER w
FROM   t
WINDOW w AS (PARTITION BY c ORDER BY a);
```

### Window chaining

A window definition can extend another by name:

```sql
SELECT group_concat(b, '.') OVER (
  win ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
)
FROM t
WINDOW win AS (PARTITION BY a ORDER BY c);
```

Rules for the chained (new) window:

- The new window must not redeclare `PARTITION BY` — it is inherited
  from the base.
- If the base has an ORDER BY, the new window must not redeclare it
  (it is inherited). If the base has none, the new window may add one.
- The base window must *not* contain a frame-spec; the frame-spec
  always comes from the new window.

Note: `OVER win` (bareword) and `OVER (win)` differ — the parenthesised
form will fail if `win` declares a frame, since chaining forbids the
base from having one.

### Frame specification

```ebnf
frame-spec ::= ( ROWS | RANGE | GROUPS )
               ( frame-start | BETWEEN frame-start AND frame-end )
               [ EXCLUDE ( NO OTHERS | CURRENT ROW | GROUP | TIES ) ]

frame-start, frame-end ::=
      UNBOUNDED PRECEDING
    | expr PRECEDING
    | CURRENT ROW
    | expr FOLLOWING
    | UNBOUNDED FOLLOWING
```

If only a single boundary is given (no `BETWEEN ... AND ...`), it is
the start and the end defaults to `CURRENT ROW`. The end may not be
"earlier" than the start. The default frame, used when none is
specified, is:

```
RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE NO OTHERS
```

Frame types:

| Type | Counting unit |
|---|---|
| `ROWS` | Individual rows relative to the current row. |
| `GROUPS` | Peer-groups relative to the current row (a peer-group is rows that have equal values for every ORDER BY term). |
| `RANGE` | Value-band on a single ORDER BY expression `X`: with `expr PRECEDING`, ASC means rows where `Xi >= Xc - expr`; DESC means `Xi <= Xc + expr`. Requires exactly one ORDER BY term unless using only `UNBOUNDED` / `CURRENT ROW` bounds. |

`expr` in `expr PRECEDING|FOLLOWING` must be a non-negative constant.
For ROWS/GROUPS it must be an integer; for RANGE it may be any
non-negative real. `0 PRECEDING` is equivalent to `CURRENT ROW`.

For RANGE and GROUPS, peers of the current row are part of the frame
when the boundary is `CURRENT ROW` (unless excluded).

`EXCLUDE` clause:

- `EXCLUDE NO OTHERS` — default; exclude nothing.
- `EXCLUDE CURRENT ROW` — exclude the current row; peers stay (in
  GROUPS/RANGE).
- `EXCLUDE GROUP` — exclude the current row and all its peers (and
  even in ROWS frames, peers are computed using the ORDER BY, or the
  whole partition if there is no ORDER BY).
- `EXCLUDE TIES` — keep the current row but drop its peers.

### Built-in window functions

All 11 are implemented; they ignore the frame-spec except for
`first_value`, `last_value`, `nth_value`. `FILTER` is a syntax error
on built-in window functions (it is only valid on aggregate window
functions).

| Function | Description |
|---|---|
| `row_number()` | 1-based row number within partition in ORDER BY order. |
| `rank()` | 1-based rank with gaps; all peers share the rank of the first peer. |
| `dense_rank()` | 1-based rank without gaps. |
| `percent_rank()` | `(rank-1)/(N-1)` (0.0 for partition of size 1). |
| `cume_dist()` | `last-peer-row-number/N` — cumulative distribution. |
| `ntile(N)` | Splits the partition into N approximately equal groups (larger groups first), returns 1..N. |
| `lag(expr [, offset [, default]])` | Value of `expr` from `offset` rows before (default 1). Returns NULL or `default` if out of bounds. |
| `lead(expr [, offset [, default]])` | Symmetric to lag, but later in the partition. |
| `first_value(expr)` | `expr` evaluated against the first row of the frame. |
| `last_value(expr)` | `expr` evaluated against the last row of the frame. |
| `nth_value(expr, N)` | `expr` against the N-th row of the frame (1-based), or NULL. |

For `rank`, `dense_rank`, `percent_rank`, `ntile`, peer-group is
defined by the ORDER BY of the window regardless of frame type.

### Aggregates as window functions

Any built-in aggregate (`sum`, `avg`, `count`, `min`, `max`,
`group_concat`, `total`, `json_group_*`, etc.) can be used as a window
function by adding `OVER (...)`. User-defined aggregates can also be
window-capable if registered with `sqlite3_create_window_function`
(supplying xStep, xFinal, xValue, xInverse callbacks).

```sql
SELECT a, b,
       group_concat(b, '.') OVER (ORDER BY a ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING)
FROM t1;
```

`FILTER (WHERE ...)` works on aggregate window functions: only rows
matching the filter contribute to the frame.

### History notes

Window functions arrived in 3.25.0 (2018). 3.28.0 added `EXCLUDE`, the
`GROUPS` frame type, window chaining, and `expr PRECEDING|FOLLOWING`
for RANGE frames. Translation layers targeting older SQLite must avoid
these.

## EXPLAIN and EXPLAIN QUERY PLAN

Any SQL statement may be prefixed with `EXPLAIN` or
`EXPLAIN QUERY PLAN`; the statement is then turned into a read-only
query that describes how it would execute. Either is for diagnostic
use only — the column layout and content are not stable across
releases.

```ebnf
EXPLAIN [ QUERY PLAN ] sql-stmt
```

- `EXPLAIN` returns the VDBE bytecode the statement compiles to —
  rows of `(addr, opcode, p1, p2, p3, p4, p5, comment)`.
- `EXPLAIN QUERY PLAN` (EQP) returns a small forest of nodes
  describing the high-level plan: which tables are scanned, which
  indexes are used, what kind of join algorithm, where temporary
  B-trees or sorts are used, etc. Columns are `(id, parent, notused,
  detail)` with a human-readable `detail`.
- Both affect runtime (`sqlite3_step`) only — `sqlite3_prepare` does
  the same work for plain and EXPLAINed statements (with minor
  internal differences for EQP). PRAGMAs that execute during prepare
  are unaffected by EXPLAIN; avoid prefixing PRAGMA statements with
  EXPLAIN for predictable behaviour.
- Authorizer callbacks fire regardless of EXPLAIN.

For a TDS proxy: `EXPLAIN QUERY PLAN` is useful for telemetry and for
mapping to `SET SHOWPLAN_TEXT`/SHOWPLAN_XML approximations; `EXPLAIN`
is too implementation-detail for client surfacing.

## Table-valued functions / virtual tables in FROM

Virtual tables that declare hidden columns can be invoked as
table-valued functions in FROM:

```sql
SELECT value FROM json_each('[1,2,3]');
SELECT * FROM generate_series(1, 100);
SELECT * FROM pragma_table_info('foo');
```

The arguments become equality constraints on the hidden columns of
the virtual table. Common SQLite vtabs: `json_each`, `json_tree`,
`pragma_*`, FTS5 vtabs (`fts_table('search query')`), and
extensions like `csv`, `series`.

## On the "N+1 query" pattern

SQLite is in-process; each prepared-statement step is a function
call, not a round-trip. Hundreds of small queries per logical
operation are idiomatic and efficient. This matters when designing
the TDS proxy: do not assume a query coming from a client is
expensive just because there are many. Aggregating into one large
query for "performance" is not always the right move, and may
actually hurt cache locality and code clarity. Many small queries
that hit a hot prepared-statement cache will outperform a single
ambitious query in many workloads.

## Quick syntactic cheat-sheet

```sql
-- Full shape of a SELECT
WITH RECURSIVE cte(c1, c2) AS (
  SELECT ...
  UNION ALL
  SELECT ... FROM cte WHERE ...
)
SELECT DISTINCT t.*, f(x) FILTER (WHERE x > 0) AS y,
       sum(z) OVER w AS running_total
FROM   t LEFT JOIN u USING (id), cte
WHERE  t.k IS NOT NULL
GROUP BY t.a, t.b
HAVING count(*) > 1
WINDOW w AS (PARTITION BY t.a ORDER BY t.b
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             EXCLUDE NO OTHERS)
ORDER BY 2 DESC NULLS LAST, y COLLATE NOCASE
LIMIT  50 OFFSET 100;
```
