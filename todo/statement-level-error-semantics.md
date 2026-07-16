---
name: statement-level-error-semantics
description: Match SQL Server batch continuation and error-token behavior. Use when classifying statement errors, changing executeBatch control flow, or returning multiple errors.
---

# Statement-level error semantics

Continue a batch after errors that SQL Server treats as statement-terminating
while preserving batch-aborting, transaction-dooming, and catchable behavior.

## Implementation

- Classify engine and SQLite failures by SQL Server error number, severity,
  transaction effect, and continuation behavior.
- Change batch execution to accumulate eligible errors and continue with the
  next statement without weakening `TRY/CATCH` or `XACT_ABORT` semantics.
- Emit ordered error and DONE tokens for batches containing multiple failures
  and successful statements.
- Preserve `@@ERROR`, `@@ROWCOUNT`, transaction state, and result ordering.

## Completion criteria

- Build ground-truth fixtures for constraint, conversion, syntax, and fatal
  errors on real SQL Server.
- Cover engine continuation and transaction state in unit tests.
- Verify multi-error token ordering through `tedious`.
- Document the error classification in architecture and T-SQL skills.
