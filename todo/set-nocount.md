---
name: set-nocount
description: Honor SET NOCOUNT when rendering TDS completion tokens. Use when changing engine count items or DONE, DONEPROC, and DONEINPROC token behavior.
---

# SET NOCOUNT

Suppress affected-row counts in completion tokens while `SET NOCOUNT ON` is
active, without changing statement execution or `@@ROWCOUNT`.

## Implementation

- Carry the session option into response rendering for batches, procedures,
  triggers, and nested execution.
- Clear the DONE count-valid bit and omit affected counts where SQL Server does.
- Preserve final completion tokens, errors, result sets, and `@@ROWCOUNT`.
- Match option lifetime and changes made partway through a batch or procedure.

## Completion criteria

- Add engine tests for option changes and nested execution.
- Assert exact DONE-family token bytes with NOCOUNT on and off.
- Verify driver events through `tedious` for batches and procedures.
- Update architecture, T-SQL, TDS, and tedious skills with the token rules.
