---
name: openjson-strict-paths
description: Implement strict JSON path evaluation and SQL Server errors for OPENJSON. Use when changing JSON path parsing or table-valued function execution.
---

# Implement OPENJSON strict paths

## Reproduction

```sql
SELECT [key], value
FROM OPENJSON(N'{"x":1}', 'strict $.missing');
```

At `bcad53b`, mssqlite returns custom unsupported error 40000. SQL Server
accepts strict mode and raises its JSON path error because the property is
missing. A present strict path must return the selected rowset normally.

## Implementation

- Parse `lax`/`strict` path mode for OPENJSON's root path and `WITH` column
  paths.
- Distinguish missing properties, wrong container kinds, invalid syntax, scalar
  versus fragment extraction, and malformed JSON.
- Map failures to SQL Server JSON error numbers and normal TRY/CATCH behavior.

## Completion criteria

- Cover present/missing objects, arrays and scalars; quoted keys; indexes;
  default schema; `WITH`; `AS JSON`; NULL; variables; and correlated APPLY.
- Preserve BIN2 path matching and declared output metadata.
- Differentially verify against SQL Server 2025.

## Ground truth

- [OPENJSON path modes](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql?view=sql-server-ver17#remarks)
- [JSON path expressions](https://learn.microsoft.com/en-us/sql/relational-databases/json/json-path-expressions-sql-server?view=sql-server-ver17)
