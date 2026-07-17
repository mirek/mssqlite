---
name: alter-table-alter-column
description: Implement ALTER TABLE ALTER COLUMN with SQL Server conversion, dependency, and metadata rules. Use when changing DDL, catalogs, or table rebuilds.
---

# Implement ALTER TABLE ALTER COLUMN

## Reproduction

```sql
CREATE TABLE alter_probe (value INT);
ALTER TABLE alter_probe ALTER COLUMN value BIGINT;
```

At `bcad53b`, mssqlite returns generic syntax error 102 (`Expected SELECT`). The
statement is valid SQL Server DDL.

## Implementation

- Parse type, width/precision/scale, collation, and NULL/NOT NULL changes.
- Validate existing values and dependent indexes, constraints, computed
  columns, foreign keys, views, and modules with SQL Server-compatible errors.
- Rebuild the SQLite table atomically where SQLite cannot alter in place,
  preserving catalog object ids and dependent definitions.
- Keep data conversion, rollback, and catalog visibility atomic across all
  attached database state.

## Completion criteria

- Cover widening/narrowing, numeric conversion, nullability, collation, identity
  restrictions, defaults, constraints, dependencies, failures, and rollback.
- Verify persisted schema after restart and through `sys.*`,
  `INFORMATION_SCHEMA`, and tedious metadata.
- Differentially verify against SQL Server 2025.

## Ground truth

- [ALTER TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql?view=sql-server-ver17)
