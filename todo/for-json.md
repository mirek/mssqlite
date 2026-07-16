---
name: for-json
description: Implement FOR JSON PATH and AUTO query rendering. Use when extending SELECT tails or mapping SQL Server JSON output to SQLite JSON functions.
---

# FOR JSON

Render `FOR JSON PATH` and `FOR JSON AUTO` as a single SQL Server-compatible
JSON result using SQLite JSON construction and aggregation functions.

## Implementation

- Parse PATH/AUTO modes and supported options such as `ROOT`,
  `INCLUDE_NULL_VALUES`, and `WITHOUT_ARRAY_WRAPPER`.
- Build objects without double-encoding nested JSON and preserve dotted PATH
  aliases as nested properties.
- Derive AUTO nesting from table aliases and join shape.
- Match empty-result, NULL omission, escaping, and result-column metadata.

## Completion criteria

- Cover modes and options in parser tests.
- Compare nested, empty, NULL, and escaped output with SQL Server fixtures.
- Verify large JSON values through `tedious`.
- Document deferred `FOR XML` support and any JSON divergences in agent skills.
