---
name: sql-server-differential-suite
description: Run a shared compatibility corpus against mssqlite and SQL Server 2025. Use when adding semantics, metadata, error, or protocol compatibility tests.
---

# Add a SQL Server differential compatibility suite

The repository has strong unit and tedious e2e coverage, but no reusable harness
that runs the same cases against mssqlite and a real SQL Server. Compatibility
drift therefore depends on one-off manual probes.

## Implementation

- Define a data-driven corpus with setup, query, cleanup, and normalization for
  rows, result-set boundaries, column metadata, row counts, errors, transaction
  state, and connection reuse.
- Launch `mcr.microsoft.com/mssql/server:2025-latest` in an opt-in local/CI
  profile and wait for readiness without slowing the default unit suite.
- Run mssqlite on an ephemeral port and execute both sides with the same tedious
  client and session options.
- Store intentional incompatibilities as explicit, narrow expectations; never
  normalize away SQL types, errors, or ordering that the query defines.
- Make failures print a minimal standalone T-SQL reproduction suitable for a
  new `todo/*.md` brief.

## Completion criteria

- Seed the suite with every reproduction in the current TODO index.
- Cover SQL Server image/license configuration, arm64/x64 CI constraints,
  deterministic collation/database setup, time zones, and cleanup after failure.
- Document the one-command local workflow and CI artifact format.
- Keep the default test command container-free; add a clearly named differential
  command and scheduled or manually triggered GitHub workflow.
