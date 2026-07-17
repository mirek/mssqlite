# Implement T-SQL LIKE character classes

## Summary

Ordinary LIKE rendering falls through to SQLite LIKE, which does not implement
T-SQL bracket classes. The mismatch also occurs for a declared varchar source,
so the existing collation-aware helper is not consistently selected/effective.

## Reproduction

```sql
SELECT CASE WHEN 'b' LIKE '[a-c]' THEN 1 ELSE 0 END AS value;
SELECT CASE WHEN 'z' LIKE '[^a-c]' THEN 1 ELSE 0 END AS value;
SELECT CASE WHEN '[' LIKE '[[]' THEN 1 ELSE 0 END AS value;
```

SQL Server returns 1 for all three statements. mssqlite returns 0.

## Acceptance criteria

- Support positive/negative classes, ranges, literal brackets, `%`, `_`, and
  ESCAPE with SQL Server parsing rules.
- Apply the effective SQL collation to character-class comparisons.
- Use the same behavior for literals, columns, variables, parameters, and
  computed expressions.
- Add negative cases and malformed-class cases, not only the three hits above.
