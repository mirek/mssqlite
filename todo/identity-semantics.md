---
name: identity-semantics
description: Honor IDENTITY seed, increment, explicit-insert protection, and rollback-independent allocation. Use when changing DDL, inserts, TRUNCATE, or identity state.
---

# Complete IDENTITY allocation semantics

The parser and catalog retain `IDENTITY(seed, increment)`, but SQLite rowid
allocation currently determines runtime values.

## Reproduction

```sql
CREATE TABLE identity_probe (
  id INT IDENTITY(10, 5) PRIMARY KEY,
  value INT
);
INSERT INTO identity_probe (value) VALUES (1), (2);
SELECT id FROM identity_probe ORDER BY id;
-- mssqlite: 1, 2
-- SQL Server: 10, 15

INSERT INTO identity_probe (id, value) VALUES (100, 3);
-- mssqlite: succeeds
-- SQL Server: rejects the explicit value unless IDENTITY_INSERT is ON
```

A generated value inside a rolled-back transaction is also reused by mssqlite.
SQL Server consumes identity values even when the statement fails or the
transaction rolls back.

## Implementation

- Allocate from database-owned identity state using the declared seed and
  signed increment, independently of SQLite rowid.
- Make allocation rollback-independent and concurrency-safe, while allowing
  gaps after failures and rollbacks.
- Reject explicit identity values by default and implement session-scoped
  `SET IDENTITY_INSERT table ON|OFF`, including one enabled table per session.
- Preserve `@@IDENTITY`, `SCOPE_IDENTITY()`, `IDENT_CURRENT`, bulk-copy
  keep-identity behavior, `TRUNCATE` reset, and catalog state.

## Completion criteria

- Cover positive/negative increments, non-1 seeds, supported integer and
  decimal types, bounds/overflow, multi-row inserts, failed statements,
  rollback, restart, concurrent sessions, and triggers.
- Verify `DELETE` does not reset allocation while `TRUNCATE` resets to the
  original seed.
- Assert catalog, engine, and tedious behavior against SQL Server 2025.

## Ground truth

- [IDENTITY property](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql-identity-property?view=sql-server-ver17)
- [SET IDENTITY_INSERT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-identity-insert-transact-sql?view=sql-server-ver17)
- [IDENT_CURRENT rollback behavior](https://learn.microsoft.com/en-us/sql/t-sql/functions/ident-current-transact-sql?view=sql-server-ver17)
