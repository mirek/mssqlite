---
name: scalar-result-metadata
description: Emit exact SQL Server TDS metadata for literals, casts, and scalar functions. Use when changing expression inference or COLMETADATA generation.
---

# Preserve scalar expression result metadata

Several scalar expressions return correct JavaScript values but generic wire
types. This is observable to ORMs, schema readers, and prepared clients.

## Reproduction

```sql
SELECT
  N'ok' AS text_value,
  CAST('x' AS VARCHAR(5)) AS varchar_value,
  CAST(2 AS BIT) AS bit_value;
```

At `bcad53b`, the text expressions are exposed as `nvarchar(max)` and the bit
as four-byte `IntN`. SQL Server exposes the declared/inferred character types
and lengths, and one-byte nullable-family bit metadata.

## Implementation

- Extend expression inference to produce exact SQL type descriptors for
  literals, casts, CASE/COALESCE/ISNULL, operators, and built-in functions.
- Keep runtime conversion and TDS metadata driven by the same descriptor so
  they cannot disagree.
- Preserve precision/scale, character family/width/collation, nullability,
  date/time scale, binary length, and special-type metadata.

## Completion criteria

- Add a metadata matrix for every supported scalar type and representative
  expression family, including NULL and empty result sets.
- Verify SQL batch, `sp_executesql`, prepared RPC, stored procedure, UDF, and
  `SELECT INTO` paths through tedious.
- Compare metadata and values with SQL Server 2025.
