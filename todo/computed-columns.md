---
name: computed-columns
description: Translate T-SQL computed columns to SQLite generated columns and catalog them. Use when removing the current computed-column transpile rejection.
---

# Computed columns

Render supported computed definitions as SQLite generated columns and expose
their expressions and persistence metadata through the catalog.

## Implementation

- Translate computed expressions with correct source-column binding and type
  inference.
- Map `PERSISTED` to stored generated columns and non-persisted definitions to
  virtual columns where SQLite permits.
- Validate determinism and reject definitions SQLite cannot represent with
  SQL Server-compatible errors.
- Populate `sys.computed_columns` and related object metadata.

## Completion criteria

- Cover DDL grammar and invalid definitions in parser/transpile tests.
- Exercise insert, update, indexing, persistence, and schema introspection.
- Verify computed values and catalog rows through `tedious`.
- Update T-SQL, SQLite, and catalog skills with supported expression rules.
