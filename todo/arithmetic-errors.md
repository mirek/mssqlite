---
name: arithmetic-errors
description: Raise SQL Server-compatible arithmetic errors instead of accepting SQLite NULLs or overflow coercion. Use when translating arithmetic or adding checked numeric UDFs.
---

# Arithmetic errors

Raise error 8134 for division by zero and error 8115 for arithmetic overflow
where SQLite would otherwise return NULL or coerce the result.

## Implementation

- Identify arithmetic operators and conversions that require runtime guards.
- Render guarded expressions or checked UDF calls without evaluating operands
  more than once.
- Respect result-type inference, integer width, decimal precision and scale,
  constant folding, and NULL propagation.
- Integrate failures with `TRY/CATCH`, `XACT_ABORT`, and statement-level error
  classification.

## Completion criteria

- Compare operator, aggregate, and conversion edge cases with SQL Server.
- Test generated SQL and UDF behavior against real SQLite.
- Verify error numbers and catchability through `tedious`.
- Record checked-arithmetic rules in T-SQL and SQLite skills.
