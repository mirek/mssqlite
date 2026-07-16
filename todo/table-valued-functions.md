---
name: table-valued-functions
description: Add built-in table-valued functions in FROM. Use when implementing STRING_SPLIT, OPENJSON, GENERATE_SERIES, or the shared TVF translation path.
---

# Table-valued functions

Expose `STRING_SPLIT`, `OPENJSON`, and `GENERATE_SERIES` as row sources while
keeping their SQL Server column names, types, and edge-case behavior.

## Implementation

- Parse function calls wherever a table source is accepted, including aliases
  and derived column lists.
- Translate JSON-backed functions through SQLite `json_each` where semantics
  align and provide adapters where they do not.
- Implement series generation and string splitting with deterministic ordering
  only where SQL Server promises it.
- Infer result metadata before execution so TDS columns match each function.

## Completion criteria

- Test valid and invalid TVF grammar in `tsql`.
- Compare emitted SQL and results with real SQLite and SQL Server behavior.
- Exercise each function through `tedious`, including NULL and empty inputs.
- Record discovered compatibility decisions in the relevant agent skills.
