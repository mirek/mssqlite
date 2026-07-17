# Validate constructed and converted date/time values

## Summary

SQLite date formatting currently normalizes or accepts impossible civil dates,
and `printf`-based date constructors do not propagate NULL. SQL Server validates
the calendar and reports stable error numbers.

## Reproduction

```sql
SELECT DATEFROMPARTS(2023, 2, 29) AS value;
SELECT DATEFROMPARTS(NULL, 2, 1) AS value;
SELECT DATETIMEFROMPARTS(2024, 2, 30, 1, 2, 3, 4) AS value;
SELECT DATETIMEFROMPARTS(2024, 2, 1, NULL, 2, 3, 4) AS value;
SELECT CAST('2023-02-29' AS date) AS value;
SELECT TRY_CAST('2023-02-29' AS date) AS value;
```

| Case | SQL Server 2025 | mssqlite |
|---|---|---|
| invalid `*FROMPARTS` date | error 289 | impossible date string |
| NULL `*FROMPARTS` component | `NULL` | zero-filled component |
| invalid `CAST(... AS date)` | error 241 | `2023-03-01` |
| invalid `TRY_CAST(... AS date)` | `NULL` | `2023-03-01` |

Inserting `'2023-02-29'` into a declared `date` also differs: SQL Server raises
241, while mssqlite reaches a generic 50000 error through TDS.

## Acceptance criteria

- Validate year/month/day and time component ranges before SQLite can
  normalize them.
- Propagate NULL from every `DATEFROMPARTS`/`DATETIMEFROMPARTS` component.
- Raise 289 for constructor argument failures and 241 for conversion failures;
  return NULL for TRY variants.
- Apply the same conversion on literals, variables, RPC parameters, defaults,
  table writes, and result encoding.
- Emit native date/datetime TDS metadata for constructors and casts.
