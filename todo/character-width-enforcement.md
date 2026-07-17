---
name: character-width-enforcement
description: Enforce SQL Server character widths, conversion truncation, and ISNULL result sizing. Use when changing string casts, assignment conversion, DATALENGTH, or character metadata.
---

# Enforce character widths and conversion semantics

Declared `CHAR`/`VARCHAR`/`NCHAR`/`NVARCHAR` sizes currently behave mostly as
catalog metadata. Values can exceed the declaration and scalar conversions do
not apply SQL Server's sizing rules.

## Reproduction

At `bcad53b`, through a real tedious/TDS connection:

```sql
CREATE TABLE width_probe (value VARCHAR(3));
INSERT INTO width_probe VALUES ('abcdef');
SELECT value, DATALENGTH(value) AS bytes FROM width_probe;
-- mssqlite: succeeds and returns ('abcdef', 12)
-- SQL Server: INSERT fails with string-truncation error 2628

SELECT CAST('abcdefghijklmnopqrstuvwxyz1234567890' AS VARCHAR) AS value;
-- mssqlite: all 36 characters, nvarchar(max) metadata
-- SQL Server: VARCHAR defaults to 30 in CAST and returns 30 characters

SELECT ISNULL(CAST(NULL AS VARCHAR(3)), 'abcdef') AS value;
-- mssqlite: 'abcdef', nvarchar(max) metadata
-- SQL Server: 'abc', varchar(3) metadata
```

The first result also shows `DATALENGTH` treating a `VARCHAR` column as UTF-16
after storage instead of reporting its encoded byte length.

## Implementation

- Carry character family, width, and collation through expression inference and
  assignment conversion instead of relying on SQLite text affinity.
- Apply the context-specific default length: 1 in declarations and variables,
  30 in `CAST`/`CONVERT`.
- Truncate explicit character-to-character casts, but raise SQL Server's
  assignment truncation error for DML under the default session settings.
- Make `ISNULL` convert its replacement to the first expression's type and
  width; retain the different `COALESCE` precedence rules.
- Compute `LEN`/`DATALENGTH` from the effective SQL type and encoding.

## Completion criteria

- Cover all four character families, fixed and variable widths, `max`, Unicode,
  multibyte code-page input, NULL, and boundary sizes.
- Test casts, variables, procedure parameters, table variables, DML, bulk load,
  defaults, computed expressions, and TDS metadata.
- Verify error number, statement rollback, and `TRY/CATCH` behavior for
  assignment truncation.
- Run the cases against SQL Server 2025 in the differential suite.

## Ground truth

- [char and varchar](https://learn.microsoft.com/en-us/sql/t-sql/data-types/char-and-varchar-transact-sql?view=sql-server-ver17)
- [ISNULL](https://learn.microsoft.com/en-us/sql/t-sql/functions/isnull-transact-sql?view=sql-server-ver17)
