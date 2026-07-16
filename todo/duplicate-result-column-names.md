---
name: duplicate-result-column-names
description: Preserve values for result sets containing duplicate column labels. Use when changing node:sqlite row extraction or result-to-TDS column mapping.
---

# Duplicate result column names

Stop object-shaped SQLite rows from collapsing values when two or more result
columns share the same label.

## Implementation

- Prefer positional row extraction with `StatementSync` array-return support
  when the minimum Node version provides a stable API.
- Otherwise rename SQLite outputs internally and map values back to the
  original ordered TDS metadata without exposing synthetic names.
- Preserve origin-based type inference and object output behavior expected by
  current engine consumers.
- Cover `SELECT *`, joins, aliases, expressions, and empty result sets.

## Completion criteria

- Add engine tests asserting every duplicate-labeled value by position.
- Test metadata ordering and source-column type resolution.
- Verify duplicate labels and values through `tedious` with column arrays.
- Update architecture and node-sqlite skills with the chosen extraction path.
