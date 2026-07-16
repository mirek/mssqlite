---
name: node-sqlite
description: "Comprehensive reference for the built-in Node.js node:sqlite module. Covers DatabaseSync, StatementSync, SQLTagStore, Session/changesets, user-defined functions and aggregates, authorization, online backup, serialize/deserialize, type conversion (BigInt and BLOB handling), constants, and full usage examples. Use when writing or debugging Node.js code that imports node:sqlite — opening databases, preparing statements, binding named/positional parameters, registering functions, managing transactions, or tracking changes."
---

# Node.js `node:sqlite` Reference

Complete reference for the synchronous SQLite API built into Node.js. The module is exposed under the `node:` scheme only.

Source: [Node.js SQLite docs](https://nodejs.org/api/sqlite.html)

## Import

```javascript
// ESM
import sqlite, { DatabaseSync, constants, backup } from 'node:sqlite';

// CommonJS
const { DatabaseSync, constants, backup } = require('node:sqlite');
```

Status: Release Candidate (Stability 1.2). Added in Node.js v22.5.0; refined in v23.x–v26.x.

All APIs are **synchronous** — there is no Promise-returning variant. The single async surface is `backup()`.

## Reference Files

- [database.md](database.md) — `DatabaseSync` class: constructor, all open/path forms, options (readOnly, foreign keys, timeout, readBigInts, returnArrays, allowBareNamedParameters, defensive, limits), `exec` / `prepare` / `open` / `close` / `isOpen` / `isTransaction` / `location` / `loadExtension` / `enableLoadExtension` / `enableDefensive` / `Symbol.dispose`
- [statements.md](statements.md) — `StatementSync` class: `all` / `get` / `iterate` / `run`, anonymous (`?`) and named (`:name`, `@name`, `$name`) parameters, bare named parameters, per-statement config setters, `sourceSQL` / `expandedSQL` / `columns()` metadata
- [tag-store.md](tag-store.md) — `SQLTagStore`: tagged template literal API for cached prepared statements (`run` / `get` / `all` / `iterate`), `size` / `capacity` / `clear()`
- [functions-and-auth.md](functions-and-auth.md) — `db.function()` (deterministic, directOnly, useBigIntArguments, varargs), `db.aggregate()` (start/step/result/inverse for window functions), `db.setAuthorizer()` with action codes
- [sessions-and-changesets.md](sessions-and-changesets.md) — `db.createSession()`, `Session.changeset()` / `.patchset()`, `db.applyChangeset()` with `filter` and `onConflict` callbacks, replication patterns
- [types.md](types.md) — JS↔SQLite type mapping (NULL, INTEGER, REAL, TEXT, BLOB), BigInt rules and safe-integer range, `Uint8Array`/`DataView` BLOB binding, `STRICT` tables
- [backup-serialize.md](backup-serialize.md) — async `backup()` with `source` / `target` / `rate` / `progress`, `db.serialize()` and `db.deserialize()` round-trip
- [constants.md](constants.md) — `sqlite.constants`: authorization action codes (`SQLITE_CREATE_TABLE`, etc.), authorizer return codes (`SQLITE_OK` / `SQLITE_DENY` / `SQLITE_IGNORE`), changeset conflict types and resolutions
- [examples.md](examples.md) — End-to-end patterns: CRUD with named params, manual transactions, custom functions, tag store, change replication, in-memory clone via serialize, resource cleanup with `using`

## Version availability (verified on Node 22.22)

Not everything documented here exists on every release line. Observed on
v22.22.2 (mssqlite's floor is Node ≥ 22.18):

- `db.createTagStore` is **undefined** — `SQLTagStore` is a newer (24.x+)
  addition. Guard usage or require Node 24 before relying on it.
- `StatementSync.columns()` returns `{ column: null, table: null, type: null }`
  for computed/expression columns — only direct table columns carry
  origin info. mssqlite's engine falls back to value-shape inference for
  such columns (`packages/engine/src/metadata.ts`).
- The `returnArrays` open option is not available — rows always come back
  as objects, so duplicate column names collapse.
- Available and relied on by mssqlite: `DatabaseSync`, `StatementSync`,
  `db.function()` (with `deterministic` / `varargs`), named parameters
  with bare keys (bind `{ x: 1 }` for SQL `@x`), math functions
  (`ceiling`, `power`, `ln`, …) and `concat`/`concat_ws` in the bundled
  SQLite.

## Usage in mssqlite

`@mssqlite/engine` opens one `DatabaseSync` per server, registers all
`mssqlite_*` UDFs once (see the `architecture` skill), and binds T-SQL
variables as native `@name` parameters with prefix-stripped keys.
Table-variable backing tables also use this shared connection's `temp`
schema, so their generated names include the session spid plus a monotonic
counter. `StatementSync.columns()` origins are matched back to the active
declaration to preserve TDS type and nullability metadata.
The bundled build includes JSON1's `json_each` but not the optional
`generate_series` module. The engine registers scalar adapters for
STRING_SPLIT's JSON rowset and GENERATE_SERIES step validation; the
transpiler supplies result-column hints where `StatementSync.columns()`
cannot recover a derived TVF column's declared type.
