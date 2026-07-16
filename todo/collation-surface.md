---
name: collation-surface
description: Add SQL Server-compatible per-column and expression collations. Use when implementing binary, case-sensitive, or accent-sensitive comparison behavior.
---

# Collation surface

Go beyond the default `NOCASE` approximation by honoring declared collations
for comparisons, ordering, uniqueness, and expression-level `COLLATE`.

## Implementation

- Parse and retain collation names on columns, casts, and expressions.
- Map supported binary and sensitivity combinations to registered SQLite
  collations over the repository's text encoding model.
- Apply collation precedence and surface clean errors for incompatible or
  unknown names.
- Expose declared collation metadata through catalog views.

## Completion criteria

- Compare case, accent, binary, ordering, and uniqueness fixtures with SQL
  Server for the supported collation set.
- Exercise indexes and query predicates against real SQLite.
- Verify values, ordering, and catalog metadata through `tedious`.
- Document the supported matrix in architecture, T-SQL, and SQLite skills.
