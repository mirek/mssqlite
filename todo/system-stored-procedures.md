---
name: system-stored-procedures
description: Implement common SQL Server system stored procedures used by clients and administration tools. Use when adding sp_help-family metadata and utility procedures.
---

# System stored procedures

Implement the high-value procedures `sp_help`, `sp_helptext`, `sp_columns`,
`sp_tables`, `sp_who`, `sp_helpdb`, `sp_rename`, and `sp_spaceused`.

## Implementation

- Define procedure signatures, defaults, result-set schemas, return statuses,
  messages, and errors from SQL Server ground truth.
- Implement metadata procedures over catalog tables so ordinary procedure
  execution and RPC paths can invoke them.
- Make mutating procedures such as `sp_rename` update SQLite objects and all
  affected catalog metadata atomically.
- Keep compatibility aliases and ODBC call patterns case-insensitive.

## Completion criteria

- Capture representative result metadata and values from real SQL Server.
- Test each procedure through engine EXEC and RPC invocation.
- Verify SSMS/ODBC-style calls through `tedious` where applicable.
- Update catalog, architecture, T-SQL, and tedious skills with coverage.
