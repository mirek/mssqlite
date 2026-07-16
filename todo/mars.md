---
name: mars
description: Implement TDS Multiple Active Result Sets. Use when adding MARS prelogin negotiation, session multiplexing, or interleaved request handling.
---

# MARS

Support multiple active requests on one connection while preserving request
ordering, transactions, cancellation, and result-token routing.

## Implementation

- Implement MARS capability negotiation and the required TDS framing/session
  headers from protocol ground truth.
- Route inbound messages and outbound tokens by logical request without
  corrupting packet order.
- Define interaction with the shared synchronous SQLite connection, including
  fair scheduling and suspended result streams.
- Isolate request cancellation and errors while sharing connection session
  state according to SQL Server behavior.

## Completion criteria

- Add exact wire tests for negotiation, headers, sequencing, and teardown.
- Exercise interleaved readers, writes, transactions, errors, and cancellation.
- Verify MARS-enabled `tedious` or another capable driver end to end.
- Update architecture, TDS, server, and client-testing skills.
