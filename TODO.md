# TODO

The live differential corpus currently preserves six actionable compatibility
briefs:

- [Fixed integer result metadata](todo/fixed-integer-result-metadata.md)
- [Character CAST width metadata](todo/character-cast-width-metadata.md)
- [Catalog result metadata](todo/catalog-result-metadata.md)
- [ORDER token fidelity](todo/order-token-fidelity.md)
- [RPC completion-token fidelity](todo/rpc-completion-token-fidelity.md)
- [Runtime error-stream fidelity](todo/runtime-error-stream-fidelity.md)

Each brief names its SQL Server ground truth, current mssqlite observation,
likely implementation boundary, and acceptance criteria. Exact expected drifts
remain in `packages/differential/src/corpus.ts`; removing a brief requires the
live expectation to become stale and the replacement behavior to pass.

The focused differential briefs use Microsoft SQL Server 2025 RTM-CU7,
version 17.0.4065.4, from `mcr.microsoft.com/mssql/server:2025-latest` at
digest `sha256:86cc6144ef39bb0fbed2329e1ad79b13ee82e7b2e4739213a0db0800e668a74a`.
The original mssqlite baseline was commit `bcad53b2d84a`; the reusable
`pnpm test:differential` harness now preserves the audited reproductions plus
per-case packet/token communication traces.

Replication, Service Broker, CLR integration, full-text search, linked
servers, effective query hints, Resource Governor, columnstore, In-Memory
OLTP, and Agent jobs remain out of scope.
