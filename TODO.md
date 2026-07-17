# TODO

Open work toward broader SQL Server compatibility. Each linked file is a
self-contained implementation brief; delete it and its index entry when the
work is complete.

## Protocol and operational surface

- [MARS](todo/mars.md) — Support multiplexed active requests on one TDS connection.
- [Attention and cancellation](todo/attention-cancellation.md) — Interrupt running engine work promptly and return correct cancellation tokens.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
