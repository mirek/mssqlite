---
name: exact-decimal-arithmetic
description: Preserve exact DECIMAL and NUMERIC values across parsing, execution, storage, and TDS. Use when replacing SQLite floating-point decimal operations.
---

# Exact decimal arithmetic

Route fixed-precision arithmetic through an exact representation and emit
lossless TDS decimal values instead of relying on SQLite floating affinity.

## Implementation

- Define one internal decimal representation with precision, scale, sign,
  comparison, rounding, overflow, and serialization rules.
- Infer SQL Server result precision and scale for operators, aggregates, casts,
  variables, parameters, and persisted columns.
- Implement exact operations through scaled integers, decimal strings, or UDFs
  without accidental JavaScript `number` conversion.
- Connect engine values to the existing TDS decimal codec.

## Completion criteria

- Use SQL Server ground truth for boundary precision, rounding, overflow, and
  mixed-scale arithmetic.
- Exercise storage, parameters, aggregates, and expressions against SQLite.
- Verify byte-accurate decimal results through TDS tests and `tedious`.
- Update architecture, T-SQL, SQLite, node-sqlite, and TDS skills.
