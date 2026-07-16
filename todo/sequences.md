---
name: sequences
description: Implement SQL Server sequences and NEXT VALUE FOR. Use when adding sequence DDL, catalog metadata, or atomic counter allocation.
---

# Sequences

Back `CREATE`, `ALTER`, and `DROP SEQUENCE` plus `NEXT VALUE FOR` with
cataloged, transaction-aware counters.

## Implementation

- Parse sequence data types, start, increment, bounds, cycling, and cache
  options, rejecting unsupported combinations explicitly.
- Persist sequence definitions and current values in catalog backing tables.
- Allocate values atomically and match SQL Server behavior across rollback,
  restart, exhaustion, and cycling.
- Expose sequence metadata through the expected `sys` views.

## Completion criteria

- Cover DDL and expression grammar in parser tests.
- Exercise positive and negative increments, limits, cycles, restart, and
  concurrent sessions against real SQLite.
- Verify generated values and errors through `tedious`.
- Update architecture, T-SQL, and catalog skills with the final semantics.
