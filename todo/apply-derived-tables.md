---
name: apply-derived-tables
description: Generalize CROSS and OUTER APPLY beyond the current narrow correlated TOP and TVF rewrites. Use when changing lateral table-source execution.
---

# Generalize APPLY-derived table execution

`CROSS`/`OUTER APPLY` parse, but ordinary correlated derived tables outside the
special rewrite shapes fail.

## Reproduction

```sql
SELECT p.id, q.n
FROM (SELECT 1 AS id UNION ALL SELECT 2) AS p
CROSS APPLY (SELECT p.id + 1 AS n) AS q;
```

At `bcad53b`, mssqlite rejects the query instead of returning `(1,2)` and
`(2,3)`. Current support is limited to selected TVFs and simple correlated
`TOP (1)` equality patterns.

## Implementation

- Represent lateral dependencies explicitly rather than recognizing a fixed
  collection of syntax patterns.
- Lower supported correlated subqueries to SQLite lateral-equivalent plans or
  execute them through a bounded engine operator when no safe rewrite exists.
- Preserve CROSS row elimination, OUTER NULL extension, ordering/TOP, aggregate
  semantics, aliases, and metadata.

## Completion criteria

- Cover correlated and uncorrelated SELECTs, zero/one/many rows, aggregates,
  predicates, ordering/TOP, nested APPLY, TVFs, stars, and both APPLY variants.
- Reject genuinely unsupported correlations with a specific compatibility error
  rather than generic syntax error 102.
- Differentially verify against SQL Server 2025.

## Ground truth

- [FROM clause plus JOIN and APPLY](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql?view=sql-server-ver17)
