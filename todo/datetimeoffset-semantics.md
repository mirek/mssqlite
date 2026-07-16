---
name: datetimeoffset-semantics
description: Preserve datetimeoffset offsets in operations and TDS values. Use when changing date storage, comparison, DATEPART behavior, or datetimeoffset encoding.
---

# datetimeoffset semantics

Retain the original UTC offset and apply SQL Server rules to comparison,
conversion, date functions, arithmetic, and wire round trips.

## Implementation

- Define a lossless internal representation for local civil time, fractional
  precision, and offset minutes.
- Normalize instants for comparison while preserving offsets for formatting
  and offset-sensitive date parts.
- Update date UDFs, casts, parameters, persisted values, and metadata inference.
- Encode and decode TDS `datetimeoffset` without routing through JavaScript
  `Date` or losing precision.

## Completion criteria

- Compare cross-offset equality, ordering, DST-independent arithmetic,
  rounding, and range limits with SQL Server.
- Exercise literals, storage, parameters, and date functions.
- Add byte-level TDS tests and verify round trips through `tedious`.
- Update architecture, T-SQL, SQLite, and TDS skills.
