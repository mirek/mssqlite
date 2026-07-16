---
name: multiple-databases
description: Design and implement multiple SQL Server databases over SQLite attachments. Use when changing USE, name flattening, catalog ownership, or database lifecycle.
---

# Multiple databases

Replace label-only `USE` behavior with database-scoped storage and catalogs,
using SQLite `ATTACH` where it preserves SQL Server semantics.

## Implementation

- Write and review a design for file ownership, attach lifecycle, name
  resolution, connection sharing, transactions, and failure recovery first.
- Implement `CREATE`, `ALTER`, and `DROP DATABASE` plus real `USE` and
  three-part-name resolution.
- Give each database independent schemas, object identifiers, catalog rows,
  settings, and persistent state while retaining server-level metadata.
- Define cross-database query, transaction, procedure, and temporary-object
  behavior within SQLite constraints.

## Completion criteria

- Land the design decision in the architecture skill before implementation.
- Test lifecycle, restart, isolation, name collisions, and cross-database use.
- Verify database switching and metadata through multiple `tedious` sessions.
- Document intentional SQLite-driven divergences in architecture and SQL skills.
