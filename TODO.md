# TODO

No implementation briefs remain from the compatibility audit. New gaps found
by the differential corpus should be added as self-contained `todo/*.md`
briefs and indexed here.

The focused differential briefs use Microsoft SQL Server 2025 RTM-CU7,
version 17.0.4065.4, from `mcr.microsoft.com/mssql/server:2025-latest` at
digest `sha256:86cc6144ef39bb0fbed2329e1ad79b13ee82e7b2e4739213a0db0800e668a74a`.
The original mssqlite baseline was commit `bcad53b2d84a`; the reusable
`pnpm test:differential` harness now preserves the audited reproductions.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
