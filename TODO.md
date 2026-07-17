# TODO

Open work toward broader SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Protocol and operational surface

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
