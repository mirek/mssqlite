---
name: bulk-load
description: Implement TDS Bulk Load message handling for bcp and SqlBulkCopy. Use when decoding packet type 7 streams or inserting bulk rows efficiently.
---

# Bulk load

Accept TDS Bulk Load messages and stream rows into the engine for compatibility
with `bcp` and `SqlBulkCopy`.

## Implementation

- Decode bulk metadata, row tokens, NULLs, PLP values, and supported TDS types
  incrementally without buffering unbounded input.
- Bind decoded rows to validated target columns and insert them efficiently in
  transaction-sized batches.
- Match constraint, conversion, cancellation, partial-failure, row-count, and
  DONE/error token behavior.
- Apply decoder robustness and value-length invariants to hostile input.

## Completion criteria

- Add annotated payload fixtures and truncation/fuzz tests in `tds`.
- Exercise large, mixed-type, NULL, failure, rollback, and cancellation loads.
- Verify `SqlBulkCopy` and a representative `bcp` workflow end to end.
- Update architecture, TDS, engine, server, and tedious skills.
