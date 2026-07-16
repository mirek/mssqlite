---
name: pivot-unpivot
description: Implement T-SQL PIVOT and UNPIVOT translation. Use when adding pivot grammar or rewriting row-to-column and column-to-row operations.
---

# PIVOT and UNPIVOT

Translate `PIVOT` to conditional aggregation and `UNPIVOT` to `UNION ALL`
while retaining SQL Server naming, NULL, and type behavior.

## Implementation

- Parse aggregate, pivot key, value list, aliases, and unpivot column lists.
- Build conditional aggregate expressions without duplicating source
  evaluation or changing grouping columns.
- Expand unpivoted columns to rows and omit NULL values as SQL Server does.
- Resolve generated column metadata and reject duplicate output names cleanly.

## Completion criteria

- Cover complete grammar and malformed clauses in parser tests.
- Execute representative rewrites against real SQLite and compare with SQL
  Server, including NULLs and mixed affinities.
- Verify result metadata and values through `tedious`.
- Record discovered compatibility decisions in the relevant agent skills.
