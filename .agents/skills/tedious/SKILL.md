---
name: tedious
description: "Using the tedious MSSQL client against mssqlite — connection options that matter (TLS, port, useColumnNames), Request API and events (row, infoMessage on the connection, done vs doneInProc), how tedious maps operations to the wire (sp_executesql RPC, sp_prepare handles, transaction manager), and e2e testing patterns. Use when writing server e2e tests or debugging client interop."
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
    encrypt: true,               // tedious default; server needs TLS key + cert
    trustServerCertificate: true,
    database: 'master',
    useColumnNames: true,        // row event gives an object keyed by column name
    connectTimeout: 5000,
    requestTimeout: 5000
  }
})
```

- tedious ≥ 16 defaults to `encrypt: true`. Start mssqlite with
  `tls: { key, cert }`; required encryption is the server default whenever TLS
  is configured. `trustServerCertificate: true` is appropriate only for an
  explicitly trusted self-signed development certificate. For a plaintext
  local server with no TLS configuration, set `encrypt: false`.
- To validate a private CA, set `trustServerCertificate: false` and pass it as
  `cryptoCredentialsDetails: { ca }`. `serverName` must match a certificate
  DNS/IP subject alternative name; Node rejects an IP literal as an SNI name,
  so set a DNS `serverName` even when the TCP target is an IP.
- `connection.connect(callback)` — the callback fires after LOGINACK +
  final DONE. `connection.state.name === 'LoggedIn'` confirms handshake.
- Failed logins surface as `ConnectionError` from the ERROR token.

## How tedious talks to the server

| tedious call | Wire | mssqlite handling |
|---|---|---|
| `execSql(request)` without params | SQL batch (0x01) | `engine.executeBatch` |
| `execSql(request)` with params | RPC `sp_executesql` (by name) | `engine.executeSql` |
| `callProcedure(request)` | RPC by procedure name | system/user procedure dispatch, result sets + return status |
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
  Duplicate labels necessarily overwrite in this object form. Use
  `useColumnNames: false` when labels may repeat; the `row` event then receives
  an ordered column array and mssqlite preserves every positional value.
- **`infoMessage` fires on the Connection, not the Request** — PRINT
  output and other INFO tokens land there. `errorMessage` likewise.
- The request callback's error is an MSSQL-shaped error with `.number`
  (e.g. 208 invalid object, 2627 unique violation) — assert on it.
- Multiple ERROR tokens produce an `AggregateError` whose `.errors` retain
  token order; the Connection's `errorMessage` events interleave with Request
  `row` events, so test mixed failing/successful batches through both streams.
- `done` / `doneInProc` / `doneProc` events mirror the DONE token family;
  counts from tokens carrying DONE_COUNT contribute to the Request callback's
  rowCount. Trigger-body DML can therefore add to the originating count.
  NOCOUNT makes the event argument `undefined` and excludes that completion
  from the callback total; result rows and `@@ROWCOUNT` remain available.

## Testing patterns

- Listen on port 0 and read the assigned port
  (`await listen({ port: 0 })`).
- TLS e2e tests use a fixed localhost certificate and exercise tedious with its
  current encryption default, private-CA validation, hostname mismatch,
  plaintext rejection, and the higher-level `mssql` client.
- One shared connection in `beforeAll` keeps tests fast; open a second
  connection inside a test to check session isolation.
- Multiple-database e2e tests should switch only the second connection with
  `USE`, verify DB_NAME()/DB_ID() and local metadata there, then query the same
  object through a three-part name on the still-master first connection.
- Wrap Request in a promise helper collecting rows + rowCount (see
  `server.test.ts`).
- Keep a table variable's declaration and all references in one SQL-batch
  request; a later `execSql` call is a new batch and must receive error 1087.
- TVF result metadata is available even for NULL/empty inputs. Remember that
  tedious surfaces STRING_SPLIT's bigint `ordinal` as a string, while
  GENERATE_SERIES over int literals retains IntN(4) and surfaces numbers.
- APPLY e2e tests should cover both CROSS row elimination and OUTER NULL
  extension; use explicit projected columns for rewritten TOP (1) sources.
- PIVOT/UNPIVOT e2e tests should listen for `columnMetadata` as well as rows:
  all-NULL generated PIVOT columns must retain the aggregate input TYPE_INFO,
  while UNPIVOT's name column is NVARCHAR and its value column keeps the
  common declared input type.
- Advanced-grouping e2e tests must include a real NULL detail row and the
  visually identical subtotal NULL, distinguished by GROUPING(). The latter
  arrives as nullable-family `IntN(1)` metadata and a JavaScript number;
  grouped and aggregate columns retain their declared source-derived widths.
- FOR JSON arrives as one column named
  `JSON_F52E2B61-18A1-11d1-B105-00805F49916B` with NVarChar(max) metadata.
  Test a value larger than 8 KiB so the server's PLP path is exercised;
  tedious still surfaces the completed value as one JavaScript string.
- User-function e2e tests should cover a scalar declared return type (BIGINT
  arrives as IntN(8) and a string) and an inline TVF used as an ordinary FROM
  source. CREATE FUNCTION definitions must be sent in their own request/batch.
- System-procedure e2e tests should use `Request.callProcedure()` with named
  parameters and collect every `columnMetadata`/`row` group: `sp_help`,
  `sp_helpdb`, and `sp_spaceused` can emit multiple result sets. Procedure names
  and `sys.` aliases are case-insensitive. Test `sp_rename` by querying the
  renamed SQLite object afterward, not only by inspecting its return status.
- Catalog-coverage tests should query `INFORMATION_SCHEMA` and `sys.dm_exec_*`
  through ordinary `execSql`, asserting `columnMetadata` as well as values.
  Open a second tedious connection to prove session rows are server-wide; the
  querying connection should see its own request 0 as `running`/`SELECT`.
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
