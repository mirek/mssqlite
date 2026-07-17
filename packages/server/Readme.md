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

const server = await listen({
  path: 'data.db',
  port: 1433,
  authentication: { type: 'insecure' }
})
// ...
await server.close()
```

The command-line entry point deliberately starts a plaintext, authentication-
disabled local-development server. Embedded callers must choose an explicit
authentication policy. Connect to the CLI with encryption disabled:

```ts
import { Connection } from 'tedious'

const connection = new Connection({
  server: '127.0.0.1',
  authentication: { type: 'default', options: { userName: 'sa', password: '...' } },
  options: { port: 1433, encrypt: false, trustServerCertificate: true }
})
```

Embedded servers can require full-session TLS. Supplying TLS configuration is
secure by default: the server advertises `ENCRYPT_REQ`, requires a TLS-capable
client, and uses TLS 1.2 or newer.

```ts
import { readFile } from 'node:fs/promises'
import { listen } from '@mssqlite/server'

const server = await listen({
  path: 'data.db',
  port: 1433,
  authentication: { type: 'insecure' },
  tls: {
    key: await readFile('server-key.pem'),
    cert: await readFile('server-cert.pem')
  }
})
```

Modern `tedious` defaults then work unchanged; use
`trustServerCertificate: true` only for an explicitly trusted self-signed
development certificate. `tls.mode: 'optional'` permits clients that send
`ENCRYPT_NOT_SUP` to remain plaintext while encrypting every TLS-capable
client. Omitting `tls` advertises `ENCRYPT_NOT_SUP` and is the explicit
plaintext development mode. `requestClientCertificate` and
`rejectUnauthorized` pass client-certificate policy to Node TLS.

## Authentication

Password authentication accepts only versioned scrypt hashes; plaintext
passwords are never retained in server configuration or SQLite. Generate a
hash offline with `hashPassword`, configure one or more case-insensitive SQL
login names, and use required TLS:

```ts
import { hashPassword, listen } from '@mssqlite/server'

const server = await listen({
  path: 'data.db',
  port: 1433,
  authentication: {
    type: 'password',
    credentials: [ {
      userName: 'sa',
      passwordHash: hashPassword(process.env.MSSQLITE_SA_PASSWORD!)
    } ]
  },
  tls: { key, cert }
})
```

For rotation without restart, pass `credentials: () => currentCredentials`;
the provider is re-read and validated for each LOGIN7. Replace the complete
immutable array atomically. Unknown users, wrong/missing passwords, malformed
names, and provider failures all perform the same fixed-parameter scrypt work
and receive generic error 18456. Configured names become the session identity
visible through `SUSER_SNAME()` and `sys.dm_exec_sessions`. SQL authentication
is the only authenticated mode; SSPI/NTLM/Kerberos and federated authentication
remain unsupported.

`authentication: { type: 'insecure' }` accepts any LOGIN7 identity and is an
explicit development-only opt-in. Password mode rejects absent or optional TLS
because LOGIN7 password scrambling is not transport encryption.

## Protocol support

- **Handshake** — PRELOGIN (version, OFF/ON/NOT_SUP/REQ encryption
  negotiation and opt-in MARS), TDS 7.4 TLS handshake records wrapped in PRELOGIN
  packets, then full-session encrypted transport; LOGIN7 decode with explicit
  insecure or scrypt-backed SQL-login validation, login response with ENVCHANGE
  database/collation/language/packet size and LOGINACK (TDS 7.4,
  "SQL Server 2019" 15.0.2000).
- **SQL batch (0x01)** — full T-SQL batches through the engine;
  COLMETADATA + ROW streams, DONE with row counts, INFO for PRINT,
  ERROR tokens with MSSQL numbers/severity on failure. Table variables
  remain scoped to the batch or stored procedure that declares them;
  `STRING_SPLIT`, `OPENJSON`, and `GENERATE_SERIES` stream ordinary result
  rows with predeclared metadata. OPENJSON preserves strict-path errors and
  supports correlated APPLY inputs; other common correlated APPLY shapes are
  translated before execution. SELECT INTO persists the inferred result types,
  widths, nullability, collation, and eligible identity for subsequent wire
  queries. PIVOT and UNPIVOT rewrites preserve generated
  result names and types on the wire, including all-NULL columns; ROLLUP,
  CUBE, GROUPING SETS, and GROUPING() stream compound subtotal results with
  stable metadata. Per-statement SET NOCOUNT state clears DONE_COUNT and its
  uint64 row count without removing completion tokens or changing
  `@@ROWCOUNT`. FOR JSON PATH/AUTO returns the SQL Server magic-named
  `nvarchar(max)` JSON column and streams large values with PLP framing.
  Persisted scalar and inline table-valued user functions execute through the
  same engine and expose their declared return/source metadata. Ordinary scalar
  projections carry the same exact TYPE_INFO (family, width, precision/scale,
  temporal scale, collation, and nullability) through SQL batches, parameterized
  RPCs, prepared handles, stored procedures, UDFs, empty results, and SELECT INTO.
- **RPC (0x03)** — `sp_executesql` (by id and name; how tedious sends
  parameterized queries), `sp_prepare` / `sp_execute` / `sp_unprepare`
  handles, `sp_reset_connection`, user procedures, and the common system
  procedures `sp_help`, `sp_helptext`, `sp_columns`, `sp_tables`, `sp_who`,
  `sp_helpdb`, `sp_spaceused`, and `sp_rename`; OUTPUT parameters use
  RETURNVALUE with RETURNSTATUS + DONEPROC framing.
- **Transaction manager (0x0E)** — begin/commit/rollback/save mapped to
  engine transactions with ENVCHANGE type 8/9/10 descriptors (how tedious
  `beginTransaction()` works).
- **Bulk load (0x07)** — an `INSERT BULK` SQL batch establishes validated
  target columns, then packet fragments feed bounded COLMETADATA/ROW/PLP
  decoding directly into an engine savepoint. Successful loads return final
  DONE_COUNT; malformed data, conversion or constraints return ERROR +
  DONE_ERROR and roll back. IGNORE and Attention cancellation also roll back.
  This interoperates with `tedious` `execBulkLoad`, node-mssql `request.bulk`
  (its SqlBulkCopy-style API), and the equivalent BCP token stream. Each type-7
  request is atomic; `freebcp -b` sends separate requests, so an earlier batch
  remains committed if a later batch fails.
- **Attention (0x06)** — aborts the active SQL/RPC execution at its next
  cooperative boundary, drops unsent output, closes the canceled response,
  then sends a separate DONE_ATTN acknowledgement. A pre-EOM cancellation uses
  the packet IGNORE bit instead: its payload is never executed and receives one
  ordinary final DONE. Completed statements in an explicit transaction remain
  pending, and the connection is reusable after either path. The synchronous
  `node:sqlite` API has no interruption method, so one already-entered SQLite
  statement remains atomic; interpreted loops and statement sequences are
  promptly cancelable.
- **MARS / SMP** — after a MARS-enabled login, SYN opens independent logical
  request streams and every TDS packet travels in a sequenced SMP DATA frame.
  Packet reassembly, bulk state, errors, Attention, and teardown are isolated
  by SID; prepared handles, database context, and transactions remain shared by
  the physical connection. Sliding windows bound each stream and a round-robin
  writer lets an unblocked sibling progress when another reader stops consuming.
  FIN aborts only its logical request and receives a matching FIN.
- Packet-size negotiation from LOGIN7; responses split across packets.

Each physical connection gets one engine session (selected database, variables,
transactions, `@@`-state); MARS logical sessions share it while retaining their
own wire/request state. CREATE/ALTER/DROP DATABASE, USE, and three-part
names operate across database-scoped SQLite stores shared by those sessions.
Authenticated connections and in-flight requests are visible through the
minimal `sys.dm_exec_sessions` / `sys.dm_exec_requests` surface and are removed
on request completion or socket close.

Mixed-success batches retain SQL Server token order: each recoverable engine
error becomes ERROR + DONE_ERROR/DONE_MORE, followed by later result metadata,
rows and DONE tokens. A terminal `BatchError` carries already-produced items so
the server never discards results that preceded the failure.
