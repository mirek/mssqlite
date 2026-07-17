---
name: merge-validation
description: Enforce SQL Server MERGE terminator and arm-order validation before mutation. Use when changing MERGE parsing, binding, or execution.
---

# Validate MERGE syntax and arm ordering

mssqlite accepts MERGE forms that SQL Server rejects and mutates the target
instead of returning the documented compile error.

## Reproduction

```sql
MERGE merge_probe AS t
USING (VALUES (1, 2)) AS s(id, value)
ON t.id = s.id
WHEN NOT MATCHED THEN
  INSERT (id, value) VALUES (s.id, s.value)
-- no semicolon: mssqlite succeeds; SQL Server raises 10713

MERGE merge_probe AS t
USING (VALUES (1, 3)) AS s(id, value)
ON t.id = s.id
WHEN MATCHED THEN UPDATE SET value = s.value
WHEN MATCHED AND s.value > 0 THEN DELETE;
-- mssqlite succeeds; SQL Server requires a condition on the first arm
```

## Implementation

- Require the MERGE statement terminator without treating semicolons on other
  statements as mandatory.
- Validate arm counts, ordering, conditions, and action combinations during
  binding before any target snapshot or mutation.
- Return SQL Server error numbers and leave the target unchanged.

## Completion criteria

- Cover every valid/invalid MATCHED, NOT MATCHED BY TARGET, and NOT MATCHED BY
  SOURCE combination, including duplicate actions and unreachable arms.
- Assert atomic failure, `TRY/CATCH`, and TDS error metadata.
- Differentially verify against SQL Server 2025.

## Ground truth

- [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql?view=sql-server-ver17)
