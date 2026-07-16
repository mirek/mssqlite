---
name: table-variables
description: Implement T-SQL table variables with session-scoped storage. Use when adding DECLARE TABLE syntax or resolving table-variable names in queries and DML.
---

# Table variables

Implement `DECLARE @name TABLE (...)` and allow the declared table to
participate in `INSERT`, `UPDATE`, `DELETE`, and `SELECT` for the lifetime of
the session scope.

## Implementation

- Parse table-shaped declarations and retain column definitions in the AST.
- Allocate collision-free SQLite temporary table names per declaration and map
  every reference through the active variable scope.
- Drop or otherwise isolate backing tables when the declaring scope ends.
- Preserve SQL Server visibility rules across batches, procedures, and nested
  procedure calls.

## Completion criteria

- Cover declaration and references in parser tests.
- Exercise DML and scope cleanup against real SQLite in engine tests.
- Verify a representative workflow through a real `tedious` connection.
- Record discovered compatibility decisions in the relevant agent skills.
