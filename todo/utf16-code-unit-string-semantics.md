# Respect non-SC UTF-16 code-unit string semantics

## Summary

The advertised default collation, `SQL_Latin1_General_CP1_CI_AS`, is not a
supplementary-character (`_SC`) collation. SQL Server therefore counts and
reports UTF-16 code units for several string functions. SQLite and JS helpers
currently operate on Unicode code points.

## Reproduction

```sql
SELECT UNICODE(N'😀') AS value;
SELECT LEN(N'😀') AS value;
SELECT NCHAR(128512) AS value;
```

| Query | SQL Server 2025 | mssqlite |
|---|---|---|
| `UNICODE(N'😀')` | `55357` (high surrogate) | `128512` |
| `LEN(N'😀')` | `2` | `1` |
| `NCHAR(128512)` | `NULL` | `😀` |

## Acceptance criteria

- Make string indexing/counting conditional on the effective SQL collation's
  supplementary-character behavior.
- Match `UNICODE`, `NCHAR`, `LEN`, `SUBSTRING`, `LEFT`, `RIGHT`, `STUFF`, and
  `REVERSE` for supplementary characters under the advertised default.
- Keep `_SC` behavior available when an implemented SC collation is added.
- Verify values through tedious so invalid-surrogate handling cannot be hidden
  by an internal JS-only assertion.
