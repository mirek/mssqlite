---
name: string-comparison-padding
description: Apply SQL Server trailing-space padding rules to character comparisons. Use when changing collations, comparison operators, joins, or unique-key evaluation.
---

# Match trailing-space comparison rules

SQL Server pads the shorter character operand with spaces for most equality and
ordering comparisons. mssqlite currently delegates the unequal-length strings
to SQLite.

## Reproduction

```sql
SELECT CASE WHEN 'a' = 'a ' THEN 1 ELSE 0 END AS equal;
```

At `bcad53b`, mssqlite returns `0`; SQL Server returns `1`. This affects filters,
joins, grouping, `DISTINCT`, uniqueness, and foreign-key matching. `LIKE` has a
different trailing-blank rule and must not be changed indiscriminately.

## Implementation

- Incorporate SQL Server padding into every supported character collation's
  equality and ordering key.
- Apply it consistently to scalar predicates and SQLite-backed relational
  operators while preserving the documented `LIKE` exception.
- Compose padding with case, accent, binary, and explicit-collation precedence.

## Completion criteria

- Cover `char`/`varchar`/`nchar`/`nvarchar`, literals, columns, mixed lengths,
  empty strings, Unicode spaces, every supported collation, and `LIKE`.
- Exercise predicates, joins, grouping, set operations, constraints, and
  indexes against SQL Server 2025.
