# @mssqlite/server

MSSQL-compatible TDS server over SQLite — the top of the mssqlite stack.
Accepts real MSSQL clients (tested end-to-end with
[tedious](https://github.com/tediousjs/tedious)) and executes their T-SQL
against [`@mssqlite/engine`](../engine).

## Run

```sh
node packages/server/src/bin.ts [path] [port]
# → mssqlite listening on port 1433, database :memory:
```

Or embedded:

```ts
import { listen } from '@mssqlite/server'

const server = await listen({ path: 'data.db', port: 1433 })
// ...
await server.close()
```

Connect with any TDS 7.4 client — encryption must be disabled (the server
answers `ENCRYPT_NOT_SUP` in prelogin):

```ts
import { Connection } from 'tedious'

const connection = new Connection({
  server: '127.0.0.1',
  authentication: { type: 'default', options: { userName: 'sa', password: '...' } },
  options: { port: 1433, encrypt: false, trustServerCertificate: true }
})
```

## Protocol support

- **Handshake** — PRELOGIN (version, encryption NOT_SUP, MARS off),
  LOGIN7 decode (any credentials accepted), login response with ENVCHANGE
  database/collation/language/packet size and LOGINACK (TDS 7.4,
  "SQL Server 2019" 15.0.2000).
- **SQL batch (0x01)** — full T-SQL batches through the engine;
  COLMETADATA + ROW streams, DONE with row counts, INFO for PRINT,
  ERROR tokens with MSSQL numbers/severity on failure. Table variables
  remain scoped to the batch or stored procedure that declares them;
  `STRING_SPLIT`, `OPENJSON`, and `GENERATE_SERIES` stream ordinary result
  rows with predeclared metadata; common correlated APPLY shapes are
  translated before execution. PIVOT and UNPIVOT rewrites preserve generated
  result names and types on the wire, including all-NULL columns.
- **RPC (0x03)** — `sp_executesql` (by id and name; how tedious sends
  parameterized queries), `sp_prepare` / `sp_execute` / `sp_unprepare`
  handles, `sp_reset_connection`, OUTPUT parameters via RETURNVALUE,
  RETURNSTATUS + DONEPROC framing.
- **Transaction manager (0x0E)** — begin/commit/rollback/save mapped to
  engine transactions with ENVCHANGE type 8/9/10 descriptors (how tedious
  `beginTransaction()` works).
- **Attention (0x06)** — acknowledged with DONE_ATTN.
- Packet-size negotiation from LOGIN7; responses split across packets.

Each connection gets its own engine session (variables, transactions,
`@@`-state); all sessions share the server's SQLite database.
