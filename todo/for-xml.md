---
name: for-xml
description: Implement the common FOR XML serialization modes with SQL Server result shape. Use when changing SELECT tails, XML serialization, or PLP metadata.
---

# Implement FOR XML

## Reproduction

```sql
SELECT 1 AS value FOR XML PATH('row');
```

At `bcad53b`, mssqlite returns generic syntax error 102. SQL Server serializes
the row as XML. `FOR JSON` already demonstrates the required pattern of a
SELECT-tail AST, serializer, magic result shape, and large-value TDS path.

## Implementation

- Parse and execute the high-value `RAW`, `AUTO`, `EXPLICIT`, and `PATH` modes
  incrementally, starting with `PATH` and `RAW`.
- Support element/attribute aliases, nesting, NULL directives, ROOT, TYPE,
  namespaces, escaping, and binary handling as each mode requires.
- Emit SQL Server-compatible column naming and XML/`nvarchar(max)` TDS metadata,
  including PLP streaming for large results.

## Completion criteria

- Add parser, serializer, engine, metadata, and tedious tests for empty, single,
  joined, nested, NULL, escaped, Unicode, binary, and >8 KiB results.
- Verify subquery `TYPE` behavior separately from top-level serialization.
- Differentially verify supported modes against SQL Server 2025 and reject the
  rest with specific unsupported errors rather than syntax 102.

## Ground truth

- [FOR XML](https://learn.microsoft.com/en-us/sql/relational-databases/xml/for-xml-sql-server?view=sql-server-ver17)
