---
name: opaque-special-types
description: Accept and round-trip initially opaque sql_variant, hierarchyid, geography, geometry, and XML values. Use when expanding type parsing, storage, metadata, or TDS codecs.
---

# Opaque special types

Provide a compatibility floor for `sql_variant`, `hierarchyid`, `geography`,
`geometry`, and `xml` by preserving values before implementing rich behavior.

## Implementation

- Define accepted literal, parameter, storage, and result representations for
  each type without conflating text and binary payloads.
- Preserve declared type metadata and reject unsupported operators or methods
  explicitly.
- Add TDS type handling where a native wire representation exists; document
  any negotiated fallback.
- Keep the design extensible for later type-specific functions and indexing.

## Completion criteria

- Build ground-truth fixtures for parameter and result wire formats.
- Exercise create/insert/select/cast and persistence for each type.
- Verify lossless round trips or explicit errors through `tedious`.
- Update T-SQL, SQLite, catalog, and TDS skills with each compatibility level.
