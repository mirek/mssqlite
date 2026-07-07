---
name: verify
description: "Verify a change end-to-end by launching the real mssqlite TDS server and driving it over a socket with a real tedious client. Use after any change to tsql/transpile/catalog/engine/tds/server to observe behavior at the wire surface instead of re-running tests."
---

# Verifying mssqlite changes

The user-facing surface is a TCP TDS server; the observation point is a
real MSSQL client connection, not unit tests.

## Launch

```sh
node packages/server/src/bin.ts :memory: 14333
# → mssqlite listening on port 14333, database :memory:
```

Any free port works (1433 is the default). `:memory:` gives a throwaway
database; pass a file path to test persistence/restart behavior.

## Drive

Write a standalone `.mjs` script using `tedious` and run it from
`packages/server/` so the bare import resolves (the repo root works
too); delete it afterwards. Minimal shape:

```js
import { Connection, Request, TYPES } from 'tedious'
const connection = new Connection({
  server: '127.0.0.1',
  authentication: { type: 'default', options: { userName: 'sa', password: 'secret' } },
  options: { port: 14333, database: 'master', encrypt: false,
    trustServerCertificate: true, useColumnNames: true }
})
// connection.connect(cb), then new Request(sql, cb) + request.on('row', …)
// and connection.execSql(request); errors carry .number (MSSQL error code).
```

Any credentials pass. Parameters via `request.addParameter(name,
TYPES.Int, value)` exercise the sp_executesql RPC path — worth a probe
whenever transpile changes touch variable binding.

## Gotchas

- The server logs an `ExperimentalWarning` for `node:sqlite` on stderr —
  noise, not a failure.
- Probe error paths over the wire too: MSSQL error numbers surface on
  the tedious error object (`e.number`), e.g. 102 syntax, 208 invalid
  object, 40000 unsupported construct.
- One server hosts many sessions on one SQLite connection; a second
  concurrent connection is a cheap isolation probe.
