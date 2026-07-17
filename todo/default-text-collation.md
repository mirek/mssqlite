# Apply default SQL text collation everywhere

## Summary

The advertised default SQL collation does not consistently govern literal
comparisons, set operations, DISTINCT, or default-collated keys. SQLite BINARY
or ASCII-only NOCASE behavior leaks through.

## Reproduction

```sql
SELECT CASE WHEN 'a' = 'a   ' THEN 1 ELSE 0 END AS value;
SELECT 'a' AS value UNION SELECT 'a   ' AS value;

SET NOCOUNT ON;
DECLARE @t TABLE(v nvarchar(10));
INSERT @t VALUES (N'É'), (N'é');
SELECT COUNT(DISTINCT v) AS value FROM @t;
```

SQL Server returns 1 for the equality, one UNION row, and a distinct count of
1. mssqlite returns 0, two UNION rows, and a distinct count of 2. UNIQUE keys
likewise allow `'a'`/`'a '` and `N'É'`/`N'é'` in mssqlite while SQL Server
raises 2627 for the second value.

## Acceptance criteria

- Apply implicit `SQL_Latin1_General_CP1_CI_AS` semantics when no explicit
  collation overrides them.
- Ignore SQL comparison padding spaces and perform Unicode case folding, not
  SQLite's ASCII-only NOCASE.
- Cover predicates, IN/BETWEEN, JOIN, ORDER BY, GROUP BY, DISTINCT, set
  operations, UNIQUE constraints, and indexes with one consistent key.
- Preserve explicit collation precedence and error 468 behavior.
