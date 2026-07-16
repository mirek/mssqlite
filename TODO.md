# TODO

Open work toward broader SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Query and DML surface

- [Table-valued functions](todo/table-valued-functions.md) — Expose `STRING_SPLIT`, `OPENJSON`, and `GENERATE_SERIES` in `FROM`.
- [CROSS and OUTER APPLY](todo/cross-outer-apply.md) — Translate common lateral TVF and correlated subquery patterns.
- [PIVOT and UNPIVOT](todo/pivot-unpivot.md) — Rewrite pivot operations to conditional aggregation and `UNION ALL`.
- [Grouping sets](todo/grouping-sets.md) — Expand `ROLLUP`, `CUBE`, and `GROUPING SETS` with `GROUPING()` support.
- [FOR JSON](todo/for-json.md) — Render `FOR JSON PATH` and `AUTO` with SQLite JSON functions.
- [Scalar user functions](todo/scalar-user-functions.md) — Persist and execute scalar and inline table-valued functions.
- [Triggers](todo/triggers.md) — Support `AFTER` and `INSTEAD OF` trigger definitions and execution.
- [Cursors](todo/cursors.md) — Interpret the cursor lifecycle and maintain `@@FETCH_STATUS`.
- [Sequences](todo/sequences.md) — Back `CREATE SEQUENCE` and `NEXT VALUE FOR` with cataloged counters.

## Semantics and type fidelity

- [Statement-level error semantics](todo/statement-level-error-semantics.md) — Continue batches after eligible errors and return multiple errors correctly.
- [Arithmetic errors](todo/arithmetic-errors.md) — Raise SQL Server-compatible divide-by-zero and overflow errors.
- [Exact decimal arithmetic](todo/exact-decimal-arithmetic.md) — Preserve exact `DECIMAL` and `NUMERIC` values through execution and TDS.
- [SET NOCOUNT](todo/set-nocount.md) — Suppress affected-row DONE counts when `NOCOUNT` is enabled.
- [Computed columns](todo/computed-columns.md) — Map computed definitions to SQLite generated columns and catalog metadata.
- [Collation surface](todo/collation-surface.md) — Add per-column binary and sensitivity-aware collation behavior.
- [datetimeoffset semantics](todo/datetimeoffset-semantics.md) — Preserve offsets in comparison, date functions, and wire values.
- [rowversion](todo/rowversion.md) — Generate database-wide monotonic binary row versions.
- [Opaque special types](todo/opaque-special-types.md) — Accept and round-trip initially opaque SQL Server special types.
- [Duplicate result column names](todo/duplicate-result-column-names.md) — Preserve every value when result-set labels collide.

## Protocol and operational surface

- [TLS](todo/tls.md) — Negotiate TDS encryption and wrap connections in TLS.
- [System stored procedures](todo/system-stored-procedures.md) — Implement common metadata and administration procedures used by tools.
- [Catalog coverage](todo/catalog-coverage.md) — Fill high-value `INFORMATION_SCHEMA` and `sys` metadata gaps.
- [Multiple databases](todo/multiple-databases.md) — Design and implement database-scoped catalogs over SQLite attachments.
- [Authentication](todo/authentication.md) — Optionally validate SQL logins while retaining explicit development modes.
- [Bulk load](todo/bulk-load.md) — Handle TDS Bulk Load messages for `bcp` and `SqlBulkCopy`.
- [MARS](todo/mars.md) — Support multiplexed active requests on one TDS connection.
- [Attention and cancellation](todo/attention-cancellation.md) — Interrupt running engine work promptly and return correct cancellation tokens.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
