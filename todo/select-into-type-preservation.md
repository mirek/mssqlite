---
name: select-into-type-preservation
description: Preserve expression names, types, widths, nullability, and eligible identity properties in SELECT INTO. Use when changing inference, metadata, or table creation from queries.
---

# Preserve SELECT INTO result shape

`SELECT INTO` currently creates columns from runtime JavaScript/SQLite values
instead of the typed select-list expressions.

## Reproduction

```sql
SELECT
  1 AS id,
  CAST('x' AS VARCHAR(5)) AS value
INTO into_probe;

SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length
FROM sys.columns AS c
WHERE c.object_id = OBJECT_ID('into_probe')
ORDER BY c.column_id;
```

At `bcad53b`, mssqlite reports both columns as `nvarchar(1)` (max length 2).
SQL Server creates `id int` and `value varchar(5)` with the nullability of the
corresponding expressions.

## Implementation

- Derive the target schema from expression metadata before executing rows.
- Preserve name, exact SQL type, length/precision/scale, collation, and
  nullability; materialize computed values as ordinary columns.
- Transfer an identity property only for SQL Server's eligible query shapes.
- Keep table creation and row insertion failure behavior compatible, including
  the documented empty-table outcome outside an explicit transaction.

## Completion criteria

- Cover literals, casts, source columns, expressions, NULL, aggregates, joins,
  unions, identity columns, no-row results, and cross-database targets.
- Assert `sys.columns`, `INFORMATION_SCHEMA.COLUMNS`, subsequent DML coercion,
  and TDS metadata.
- Differentially verify against SQL Server 2025.

## Ground truth

- [SELECT INTO clause](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-into-clause-transact-sql?view=sql-server-ver17)
