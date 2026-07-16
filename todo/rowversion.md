---
name: rowversion
description: Implement SQL Server rowversion and timestamp columns. Use when adding automatic database-wide binary version generation or catalog metadata.
---

# rowversion

Generate a database-wide monotonically increasing binary(8) value whenever a
row containing `rowversion` is inserted or updated.

## Implementation

- Treat `timestamp` as the deprecated type synonym rather than a date type.
- Maintain one persistent counter per database and allocate values atomically.
- Populate the column on inserts and every qualifying update without allowing
  explicit assignment except where SQL Server permits it.
- Expose correct type, nullability, and identity-like metadata in the catalog.

## Completion criteria

- Compare DDL restrictions, update behavior, rollback gaps, and counter scope
  with SQL Server.
- Exercise multiple tables, sessions, restarts, and explicit assignments.
- Verify binary values and metadata through `tedious`.
- Update architecture, T-SQL, SQLite, and catalog skills.
