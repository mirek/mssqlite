---
name: cursors
description: Implement engine-side T-SQL cursors and @@FETCH_STATUS. Use when adding DECLARE, OPEN, FETCH, CLOSE, or DEALLOCATE cursor behavior.
---

# Cursors

Interpret the cursor lifecycle by materializing query results and moving a
session-scoped position through them.

## Implementation

- Parse cursor declarations, supported options, fetch orientations, and
  `FETCH ... INTO` targets.
- Store cursor definitions and materialized rows in the owning session scope.
- Implement `OPEN`, `FETCH`, `CLOSE`, and `DEALLOCATE` state transitions and
  update `@@FETCH_STATUS` after every fetch.
- Return SQL Server-compatible errors for duplicate, missing, or invalid-state
  operations and define cleanup at scope or connection end.

## Completion criteria

- Cover lifecycle grammar and fetch variants in parser tests.
- Exercise state transitions, empty results, variable assignment, and cleanup.
- Verify a cursor loop through a real `tedious` connection.
- Record supported cursor options and divergences in the T-SQL skill.
