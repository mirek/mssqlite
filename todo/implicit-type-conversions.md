---
name: implicit-type-conversions
description: Apply T-SQL data-type precedence to mixed-type operators and predicates. Use when changing expression evaluation, comparison, CASE, joins, or parameter coercion.
---

# Apply implicit type conversion consistently

Mixed-type arithmetic already converts character numerals to integers, but the
same precedence is not applied to comparison predicates.

## Reproduction

```sql
SELECT
  '1' + 2 AS arithmetic_value,
  CASE WHEN 1 = '1' THEN 1 ELSE 0 END AS comparison_value;
```

At `bcad53b`, mssqlite returns `(3, 0)`. SQL Server converts the lower-precedence
`varchar` value to `int` in both expressions and returns `(3, 1)`. The mismatch
can silently change `WHERE`, `JOIN`, `CASE`, `IN`, and constraint results rather
than producing a visible unsupported-feature error.

## Implementation

- Centralize binary operand coercion using SQL Server's data-type precedence
  table; do not leave comparisons to SQLite's storage-class rules.
- Reuse the same conversion path for arithmetic, comparison, `BETWEEN`, `IN`,
  simple `CASE`, set operations, table value constructors, and DML assignments.
- Preserve SQL Server conversion errors and integer/decimal overflow behavior.
- Include declared source-column types and RPC parameter types when selecting
  the common type.

## Completion criteria

- Add a pairwise matrix for numeric, bit, character, binary, date/time,
  uniqueidentifier, XML, and NULL operands, including reversed operand order.
- Exercise predicates in projections, filters, joins, constraints, MERGE arms,
  and procedure calls.
- Assert values, error numbers, and TDS result types against SQL Server 2025.

## Ground truth

- [Data type precedence](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql?view=sql-server-ver17)
- [Table value constructor conversion rules](https://learn.microsoft.com/en-us/sql/t-sql/queries/table-value-constructor-transact-sql?view=sql-server-ver17#data-types)
