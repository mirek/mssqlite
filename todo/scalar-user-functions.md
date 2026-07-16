---
name: scalar-user-functions
description: Add persisted scalar and inline table-valued user functions. Use when implementing CREATE FUNCTION, function catalog entries, or function invocation.
---

# Scalar user functions

Implement `CREATE`, `ALTER`, and `DROP FUNCTION` for scalar functions, then
support inline table-valued functions as parameterized row sources.

## Implementation

- Parse function parameters, return declarations, scalar bodies, and inline
  table-valued return queries.
- Persist definitions and metadata in `sys.objects`, `sys.sql_modules`, and
  function-specific catalog views; reload them at startup.
- Interpret scalar bodies with procedure-like scopes and recursion limits.
- Expand inline table-valued calls without changing parameter binding or
  correlation semantics.

## Completion criteria

- Test DDL and invocation grammar in `tsql`.
- Exercise persistence, ALTER/DROP, parameters, returns, and failure behavior.
- Verify scalar and inline-table calls through `tedious`.
- Update architecture, T-SQL, and catalog skills with the final model.
