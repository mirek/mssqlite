# @mssqlite/tds

TDS (Tabular Data Stream) 7.4 protocol codecs — everything the mssqlite server
needs to speak MSSQL's wire protocol. Pure functions over `Uint8Array`, built
on [`@mssqlite/bytes`](../bytes). No sockets here — transport lives in
[`@mssqlite/server`](../server).

Reference: [MS-TDS] via the [`tds-protocol` skill](../../.agents/skills/tds-protocol/SKILL.md);
token layouts are tested against its annotated hex dumps.

## Modules

### Framing

- `Packet` — 8-byte header codec (length/spid big-endian), packet `Type` and
  `Status` constants, `split(type, payload, packetSize)` producing EOM-flagged
  packet sequences.
- `Message` — incremental, allocation-light reassembly of raw stream chunks
  into complete messages: `Message.push(state, chunk)` returns the next state
  and any completed `{ type, payload }` messages. Pure — feed it socket data,
  keep the returned state.

### Handshake

- `Prelogin` — request decode (version, encryption, MARS, instance, …) and
  response encode.
- `Login7` — full decode of the fixed header, offset/length string block,
  password descrambling (`((b >> 4) | (b << 4)) ^ 0xA5` inverse) and TDS 7.4
  FeatureExt list.

### Requests (client → server)

- `AllHeaders` — ALL_HEADERS prefix with transaction descriptor.
- `SqlBatch` — batch SQL text (UCS-2, unprefixed).
- `Rpc` — procedure by name or well-known id (`Rpc.ProcId.executeSql` etc.),
  option flags, and typed parameters decoded to JS values.
- `TransactionManager` — begin/commit/rollback/save with isolation level.

### Responses (server → client)

`Token` namespace: `colMetadata`, `row`, `done` / `doneProc` / `doneInProc`
(+ `Token.Status` flags), `error` / `info`, `loginAck`, `returnStatus`,
`returnValue`, `featureExtAck` and `Token.EnvChange.*` (database, language,
packet size, collation, begin/commit/rollback transaction).

### Types and values

- `DataType` — type ids and wire-family classification (`fixed`, `byteLen`,
  `ushortLen`, `longLen`, `plp`, `date`, `scaled`, `decimal`).
- `TypeInfo` — TYPE_INFO codec plus constructors: `intN`, `bitN`, `floatN`,
  `moneyN`, `datetimeN`, `nvarchar(n | 'max')`, `varchar`, `varbinary`,
  fixed-width `binary`, `decimalN(p, s)`, `guid`, `dateN`, `timeN(s)`, `datetime2N(s)`,
  `datetimeOffsetN(s)`, `sqlVariant`, untyped/typed `xml`, and CLR `udt`.
- `Value` — TYPE_VARBYTE encode/decode between wire bytes and JS values
  (`null`, `boolean`, `number`, `bigint`, `string`, `Uint8Array`, `Date`),
  including PLP chunking for `max` types.
- `SqlVariant` — validates, packs, and unpacks the base type token,
  type-specific properties, and bare value without losing inner type identity.
  XML uses UTF-16LE PLP; UDT values use opaque binary PLP and full UDT_INFO.
- `DateTime` — proleptic-Gregorian civil date math (no JS `Date` range
  limits); datetime (1/300s), smalldatetime, date, time(n), datetime2(n),
  datetimeoffset(n). DATETIMEOFFSET encodes UTC time/date plus the retained
  signed offset, rounds with civil-day carry, and preserves all 100ns digits.
  Date/time values decode to MSSQL-style strings
  (`YYYY-MM-DD HH:MM:SS.fff…`), matching how the engine stores them in SQLite.
- `Decimal` — exact decimal codec (sign byte + little-endian magnitude) with
  string round-tripping, half-away-from-zero scale rounding, and precision
  overflow checks before bytes are emitted.
- `Guid` — mixed-endian GUID (Data1-3 LE, Data4 BE) to canonical string.
- `Collation` — 5-byte collation codec; `Collation.default_` is
  `SQL_Latin1_General_CP1_CI_AS` (`09 04 D0 00 34`).

## Example — building a query response

```ts
import { Encode } from '@mssqlite/bytes'
import { Packet, Token, TypeInfo } from '@mssqlite/tds'

const columns = [ { name: 'bar', typeInfo: TypeInfo.varchar(3) } ]
const payload = Encode.concat(
  Token.colMetadata(columns),
  Token.row(columns, [ 'foo' ]),
  Token.done(Token.Status.count, 0xc1, 1n)
)
const packets = Packet.split(Packet.Type.tabularResult, payload)
// → write packets to the socket
```
