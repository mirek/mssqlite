# TODO

Open work toward closer SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Semantics and type fidelity

- [IDENTITY semantics](todo/identity-semantics.md) — Honor seed/increment, explicit-insert protection, and rollback-independent allocation.
- [Unique NULL semantics](todo/unique-null-semantics.md) — Treat repeated NULL-containing keys as duplicates in unique constraints and indexes.
- [SELECT INTO type preservation](todo/select-into-type-preservation.md) — Preserve expression type, width, nullability, and eligible identity properties.
- [Scalar result metadata](todo/scalar-result-metadata.md) — Emit exact TDS types and sizes for literals, casts, operators, and functions.
- [String comparison padding](todo/string-comparison-padding.md) — Match SQL Server trailing-space comparison behavior across collations.
- [CP-1252 character functions](todo/cp1252-character-functions.md) — Apply the advertised Windows-1252 code page to ASCII and CHAR.
- [UTF-16 code-unit string semantics](todo/utf16-code-unit-string-semantics.md) — Respect the default non-SC collation in string indexing and counting.
- [Date validation](todo/date-validation.md) — Reject impossible civil dates and propagate NULL through date constructors.
- [JSON scalar semantics](todo/json-scalar-semantics.md) — Match ISJSON, JSON_VALUE, and JSON_QUERY value and text behavior.
- [Integer aggregate semantics](todo/integer-aggregate-semantics.md) — Preserve integer AVG values and COUNT_BIG width.
- [LIKE character classes](todo/like-character-classes.md) — Implement T-SQL bracket classes under the effective collation.
- [Default text collation](todo/default-text-collation.md) — Apply default SQL text collation to expressions and set operations.
- [Integer CAST semantics](todo/integer-cast-semantics.md) — Truncate numeric inputs and convert empty character input to zero.

## Query and DDL surface

- [VALUES-derived tables](todo/table-value-constructors-in-from.md) — Accept table value constructors as ordinary FROM sources.
- [APPLY-derived tables](todo/apply-derived-tables.md) — Generalize CROSS/OUTER APPLY beyond narrow TVF and TOP rewrites.
- [MERGE validation](todo/merge-validation.md) — Enforce terminator, arm ordering, and action constraints before mutation.
- [ALTER TABLE ALTER COLUMN](todo/alter-table-alter-column.md) — Change column types and nullability with atomic table rebuilds.
- [OPENJSON strict paths](todo/openjson-strict-paths.md) — Evaluate strict JSON paths and return SQL Server errors.
- [FOR XML](todo/for-xml.md) — Add common SQL Server XML serialization modes and wire metadata.

## Compatibility testing

- [SQL Server differential suite](todo/sql-server-differential-suite.md) — Run one typed query corpus against mssqlite and SQL Server 2025.

The focused differential briefs use Microsoft SQL Server 2025 RTM-CU7,
version 17.0.4065.4, from `mcr.microsoft.com/mssql/server:2025-latest` at
digest `sha256:86cc6144ef39bb0fbed2329e1ad79b13ee82e7b2e4739213a0db0800e668a74a`.
The mssqlite baseline was commit `bcad53b2d84a`; all 432 existing tests passed
before the differential run.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
