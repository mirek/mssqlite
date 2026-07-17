# Preserve integer AVG values and COUNT_BIG width

## Summary

Native SQLite `avg` always produces a floating-point result, while SQL Server
keeps integer AVG in the input's integer family. `COUNT_BIG` also loses its
declared bigint width when result metadata is inferred from a small value.

## Reproduction

```sql
SET NOCOUNT ON;
DECLARE @t TABLE(v int);
INSERT @t VALUES (1), (2);
SELECT AVG(v) AS value FROM @t;

SELECT COUNT_BIG(*) AS value
FROM (SELECT 1 AS x) AS q
WHERE 1 = 0;
```

For `AVG(int)`, SQL Server returns integer `1` with IntN(4); mssqlite returns
floating `1.5` with FloatN(8). The same mismatch occurs for bigint, where SQL
Server returns bigint `1`. For the empty `COUNT_BIG`, SQL Server sends bigint
`0` (tedious exposes `'0'`), while mssqlite sends int `0`.

Decimal AVG already follows a separate exact path and must not regress.

## Acceptance criteria

- Implement int and bigint AVG with SQL Server truncation, overflow, and NULL
  behavior.
- Preserve bigint wire metadata for `AVG(bigint)` and every `COUNT_BIG`,
  independent of result magnitude or emptiness.
- Cover DISTINCT, all-NULL/empty groups, windows, grouping sets, and ordinary
  aggregates.
