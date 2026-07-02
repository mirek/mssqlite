---
name: tedious
description: "Using the tedious MSSQL client against mssqlite — connection options that matter (encrypt: false, port, useColumnNames), Request API and events (row, infoMessage on the connection, done vs doneInProc), how tedious maps operations to the wire (sp_executesql RPC, sp_prepare handles, transaction manager), and e2e testing patterns. Use when writing server e2e tests or debugging client interop."
---

# tedious Client Against mssqlite

`tedious` is the pure-JS MSSQL driver used for end-to-end tests
(`packages/server/src/server.test.ts`). It exercises the full stack the
same way real applications do.

## Connection options that matter

```ts
new Connection({
  server: '127.0.0.1',
  authentication: { type: 'default', options: { userName: 'sa', password: 'any' } },
  options: {
    port,                        // pick the listener's port; 0 → ephemeral in tests
    encrypt: false,              // REQUIRED — mssqlite answers ENCRYPT_NOT_SUP
    trustServerCertificate: true,
    database: 'master',
    useColumnNames: true,        // row event gives an object keyed by column name
    connectTimeout: 5000,
    requestTimeout: 5000
  }
})
```

- `encrypt: false` is mandatory. tedious ≥ 16 defaults to `true` and will
  abort when the server reports encryption not supported.
- `connection.connect(callback)` — the callback fires after LOGINACK +
  final DONE. `connection.state.name === 'LoggedIn'` confirms handshake.
- Failed logins surface as `ConnectionError` from the ERROR token.

## How tedious talks to the server

| tedious call | Wire | mssqlite handling |
|---|---|---|
| `execSql(request)` without params | SQL batch (0x01) | `engine.executeBatch` |
| `execSql(request)` with params | RPC `sp_executesql` (by name) | `engine.executeSql` |
| `prepare(request)` / `execute(request, params)` | RPC `sp_prepare` (0xFFFF + id 11) / `sp_execute` (12) | handle map in `server/connection.ts` |
| `beginTransaction/commitTransaction/rollbackTransaction` | Transaction manager (0x0E) types 5/7/8 | engine transactions + ENVCHANGE 8/9/10 |
| `cancel()` | Attention (0x06) | DONE with DONE_ATTN |
| pooled reset | RPC `sp_reset_connection` | acknowledged no-op |

## Request API and events

```ts
const request = new Request(sql, (error, rowCount) => { ... })
request.addParameter('age', TYPES.Int, 18)   // no @ prefix — tedious adds it
request.on('row', columns => { ... })        // per row
connection.execSql(request)
```

- **`row`** — with `useColumnNames: true`, `columns` is
  `Record<name, { value }>`. Values are decoded per COLMETADATA TYPE_INFO:
  `IntN` → number, `NVarChar` → string, `DateTimeN`/`DateTime2N` → JS
  `Date`, `BitN` → boolean, `FloatN` → number.
- **`infoMessage` fires on the Connection, not the Request** — PRINT
  output and other INFO tokens land there. `errorMessage` likewise.
- The request callback's error is an MSSQL-shaped error with `.number`
  (e.g. 208 invalid object, 2627 unique violation) — assert on it.
- `done` / `doneInProc` / `doneProc` events mirror the DONE token family;
  rowCount in the callback comes from the final DONE with DONE_COUNT.

## Testing patterns

- Listen on port 0 and read the assigned port
  (`await listen({ port: 0 })`).
- One shared connection in `beforeAll` keeps tests fast; open a second
  connection inside a test to check session isolation.
- Wrap Request in a promise helper collecting rows + rowCount (see
  `server.test.ts`).
- tedious parameter types worth covering: `TYPES.Int`, `TYPES.BigInt`
  (arrives as string), `TYPES.NVarChar` (PLP when long), `TYPES.Bit`,
  `TYPES.Float`, `TYPES.DateTime` / `TYPES.DateTime2`,
  `TYPES.UniqueIdentifier`, `TYPES.VarBinary`, `TYPES.Numeric`.

## Gotchas discovered

- tedious sends `sp_executesql` by **name**, not by ProcID — handle both.
- RPC OptionFlags is 2 bytes on the wire (the MS-TDS example prose shows
  a single byte but the byte count proves otherwise).
- tedious validates TYPE_INFO strictly: NVARCHAR must carry a 5-byte
  collation; PLP `max` types use the 0xFFFF length marker and 8-byte PLP
  framing in rows.
- BigInt columns (`IntN(8)`) are surfaced by tedious as **strings**.
- LOGIN7 from tedious includes FeatureExt (UTF8 etc.); acking is optional
  — mssqlite skips FEATUREEXTACK and tedious proceeds.
