# @mssqlite/differential

Opt-in compatibility harness that sends one data-driven T-SQL corpus through
the same tedious client configuration to mssqlite and SQL Server 2025.
It compares result-set boundaries, ordered rows, complete column metadata,
DONE row counts, error number/state/class/line, transaction state, and
post-error connection reuse.

The default `pnpm test` runs only the package's container-free unit tests.
Run the live suite from the repository root:

```sh
pnpm test:differential
```

The command requires Docker, accepts the SQL Server Developer license with
`ACCEPT_EULA=Y`, and starts the pinned 2025 RTM-CU7 image on a random
loopback port. Set `MSSQLITE_DIFFERENTIAL_IMAGE` to test another image and
`MSSQLITE_DIFFERENTIAL_PASSWORD` to replace the local throwaway SA password.
The runner creates a uniquely named database with
`SQL_Latin1_General_CP1_CI_AS`, uses UTC in Node and the container, waits for
login readiness, and removes the database, mssqlite listener, connection, and
container in `finally` cleanup.

SQL Server containers are amd64. The scheduled workflow uses an x64 Linux
runner; arm64 developer machines request Docker's `linux/amd64` emulation,
which is slower and requires an emulator-capable Docker installation.

Results are written to `artifacts/differential/results.json`, including both
full snapshots, declared differences, and a standalone T-SQL reproduction for
each case. GitHub uploads that JSON even when the command fails. Error messages
remain in the artifact for diagnosis; comparisons use the stable SQL error
number, state, class, and line because server-name prefixes and wording are not
wire-semantic identifiers.

Intentional incompatibilities belong on the individual corpus case as an exact
JSON-pointer path plus both expected values and a reason. Stale expectations
fail the run, so widening a normalization cannot silently hide new drift.
