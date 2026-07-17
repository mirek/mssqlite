# TODO

Open work toward closer SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Semantics and type fidelity

- [Character width enforcement](todo/character-width-enforcement.md) — Enforce declared string sizes, CAST/CONVERT defaults, ISNULL sizing, and encoded DATALENGTH.
- [Implicit type conversions](todo/implicit-type-conversions.md) — Apply T-SQL precedence consistently to mixed-type operators and predicates.
- [IDENTITY semantics](todo/identity-semantics.md) — Honor seed/increment, explicit-insert protection, and rollback-independent allocation.
- [Unique NULL semantics](todo/unique-null-semantics.md) — Treat repeated NULL-containing keys as duplicates in unique constraints and indexes.
- [SELECT INTO type preservation](todo/select-into-type-preservation.md) — Preserve expression type, width, nullability, and eligible identity properties.
- [Scalar result metadata](todo/scalar-result-metadata.md) — Emit exact TDS types and sizes for literals, casts, operators, and functions.
- [String comparison padding](todo/string-comparison-padding.md) — Match SQL Server trailing-space comparison behavior across collations.

## Query and DDL surface

- [VALUES-derived tables](todo/table-value-constructors-in-from.md) — Accept table value constructors as ordinary FROM sources.
- [APPLY-derived tables](todo/apply-derived-tables.md) — Generalize CROSS/OUTER APPLY beyond narrow TVF and TOP rewrites.
- [MERGE validation](todo/merge-validation.md) — Enforce terminator, arm ordering, and action constraints before mutation.
- [ALTER TABLE ALTER COLUMN](todo/alter-table-alter-column.md) — Change column types and nullability with atomic table rebuilds.
- [OPENJSON strict paths](todo/openjson-strict-paths.md) — Evaluate strict JSON paths and return SQL Server errors.
- [FOR XML](todo/for-xml.md) — Add common SQL Server XML serialization modes and wire metadata.

## Compatibility testing

- [SQL Server differential suite](todo/sql-server-differential-suite.md) — Run one typed query corpus against mssqlite and SQL Server 2025.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
