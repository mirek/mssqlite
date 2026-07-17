# Apply Windows-1252 semantics to ASCII and CHAR

## Summary

mssqlite advertises `SQL_Latin1_General_CP1` and uses Windows-1252 for
non-Unicode wire values, but `ASCII` and `CHAR` currently use SQLite Unicode
code-point functions.

## Reproduction

```sql
SELECT ASCII('€') AS value;
SELECT CHAR(128) AS value;
SELECT CHAR(256) AS value;
```

| Query | SQL Server 2025 | mssqlite |
|---|---|---|
| `ASCII('€')` | `128` | `8364` |
| `CHAR(128)` | `€` | U+0080 control character |
| `CHAR(256)` | `NULL` | `Ā` |

`packages/transpile/src/functions.ts` maps both functions to SQLite Unicode
primitives even though `@mssqlite/bytes` already has the required CP-1252
codec.

## Acceptance criteria

- Decode/encode `ASCII` and `CHAR` with the advertised code page.
- Return `NULL` for out-of-range or unmappable `CHAR` input as SQL Server does.
- Return varchar/char TDS metadata rather than inferred nvarchar metadata.
- Test CP-1252 extension bytes, ASCII bytes, NULL, and boundary inputs.
