# Match integer CAST input coercion

## Summary

The strict integer conversion path rejects numeric literals that should be
truncated and empty character input that SQL Server converts to zero.

## Reproduction

```sql
SELECT CAST(1.9 AS int) AS value;
SELECT CAST(CAST(1.9 AS decimal(3,1)) AS int) AS value;
SELECT CAST('' AS int) AS value;
SELECT CAST('   ' AS int) AS value;
```

SQL Server returns `1`, `1`, `0`, and `0`. mssqlite raises error 245 for all
four. Numeric AST literals are currently rendered as quoted strings before
`mssqlite_cast_integer`, which then accepts only an integer regex.

## Acceptance criteria

- Truncate finite numeric/decimal inputs toward zero before integer range
  checking.
- Treat empty and whitespace-only character input as zero.
- Retain 245 for invalid character input and 8115 for range overflow.
- Make TRY_CAST/TRY_CONVERT return NULL for genuine failures only.
- Test every integer width and RPC/variable/table-write conversion paths.
