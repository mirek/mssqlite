---
name: attention-cancellation
description: Make TDS Attention cancel active engine execution promptly. Use when adding cooperative interruption, cancel-token responses, or long-loop abort checks.
---

# Attention and cancellation

Cancel work that is already executing, including long interpreted loops, and
return SQL Server-compatible attention acknowledgements and completion tokens.

## Implementation

- Track cancellation per active request from Attention receipt through final
  acknowledgement without confusing it with the existing ignored-message path.
- Add cooperative checks between statements, loop iterations, and other engine
  boundaries; use SQLite interruption where it is safe and available.
- Roll back or preserve transactions according to the canceled operation and
  session settings.
- Prevent late result rows or errors from leaking after cancellation and keep
  the connection reusable.

## Completion criteria

- Add exact wire tests for Attention acknowledgement and DONE status bits.
- Exercise cancellation before execution, during long loops/queries, inside a
  transaction, and immediately after completion.
- Verify driver cancel APIs and subsequent connection reuse through `tedious`.
- Update architecture, TDS, engine, server, and tedious skills.
