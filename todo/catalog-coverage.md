---
name: catalog-coverage
description: Fill high-value INFORMATION_SCHEMA and sys catalog gaps. Use when adding routines, views, constraints, SQL modules, defaults, or session/request metadata.
---

# Catalog coverage

Add `INFORMATION_SCHEMA.ROUTINES`, `VIEWS`, `TABLE_CONSTRAINTS`,
`KEY_COLUMN_USAGE`, and `REFERENTIAL_CONSTRAINTS`; complete
`sys.sql_modules` and `sys.default_constraints`; and provide minimal
`sys.dm_exec_sessions` and `sys.dm_exec_requests`.

## Implementation

- Specify each view's schema, keys, joins, built-in rows, and nullability from
  SQL Server ground truth before adding SQLite backing tables or views.
- Update DDL and session lifecycles so catalog rows remain consistent.
- Filter database-, schema-, and session-scoped rows correctly.
- Return SQL Server-compatible names, identifiers, types, and metadata.

## Completion criteria

- Add catalog schema and relationship tests for every new view.
- Exercise create/alter/drop and live-session updates against real SQLite.
- Compare representative queries and result metadata through `tedious`.
- Extend the `sys` skill with full schemas, relationships, and support notes.
