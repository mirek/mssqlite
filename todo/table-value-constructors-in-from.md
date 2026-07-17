---
name: table-value-constructors-in-from
description: Parse and execute VALUES table value constructors as ordinary FROM sources. Use when changing table-source parsing, aliases, or row-type inference.
---

# Support VALUES-derived tables in FROM

The parser accepts table value constructors for INSERT and MERGE, but not as an
ordinary derived table.

## Reproduction

```sql
SELECT value
FROM (VALUES (1), (NULL), (2)) AS source(value)
ORDER BY value;
```

At `bcad53b`, mssqlite returns syntax error 102 (`Expected SELECT`). SQL Server
returns the three rows with NULL first. This common form is useful for fixtures,
small joins, and parameter tables.

## Implementation

- Add a `VALUES` table-source AST form with mandatory alias and optional column
  aliases.
- Infer each column using the same UNION ALL/type-precedence rules as SQL Server.
- Render it directly where SQLite supports the shape or lower it to a stable
  `SELECT ... UNION ALL` form.
- Reuse it in ordinary joins, APPLY, CTEs, subqueries, and MERGE.

## Completion criteria

- Cover one/many rows and columns, expressions, variables, NULL, mixed types,
  alias errors, empty/unequal rows, joins, ordering, and metadata.
- Verify conversion failures and exact wire types against SQL Server 2025.

## Ground truth

- [Table value constructor](https://learn.microsoft.com/en-us/sql/t-sql/queries/table-value-constructor-transact-sql?view=sql-server-ver17)
