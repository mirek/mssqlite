---
name: grouping-sets
description: Implement ROLLUP, CUBE, GROUPING SETS, and GROUPING(). Use when extending aggregate grammar or expanding advanced grouping into SQLite queries.
---

# Grouping sets

Support `GROUP BY ROLLUP`, `CUBE`, and `GROUPING SETS`, including the
`GROUPING()` indicator needed to distinguish subtotal NULLs.

## Implementation

- Represent grouping-set forms explicitly in the AST and validate nesting.
- Expand sets into `UNION ALL` branches with consistent output columns and
  aggregate expressions.
- Generate subtotal placeholders and compute the `GROUPING()` bit result from
  the active branch.
- Avoid reevaluating volatile or expensive input expressions when possible.

## Completion criteria

- Test syntax, expansion order, and invalid forms in `tsql`.
- Compare rollup, cube, empty-set, and ordinary-NULL results with SQL Server.
- Verify values and metadata through `tedious`.
- Record discovered compatibility decisions in the relevant agent skills.
