# TODO

Open work toward closer SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Semantics and type fidelity

- [Scalar result metadata](todo/scalar-result-metadata.md) — Emit exact TDS types and sizes for literals, casts, operators, and functions.
- [String comparison padding](todo/string-comparison-padding.md) — Match SQL Server trailing-space comparison behavior across collations.
- [Default text collation](todo/default-text-collation.md) — Apply default SQL text collation to expressions and set operations.

## Query and DDL surface

- [APPLY-derived tables](todo/apply-derived-tables.md) — Generalize CROSS/OUTER APPLY beyond narrow TVF and TOP rewrites.
- [ALTER TABLE ALTER COLUMN](todo/alter-table-alter-column.md) — Change column types and nullability with atomic table rebuilds.
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
