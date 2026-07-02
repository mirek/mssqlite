# @mssqlite/bytes

Binary cursor, decode combinators and encode builders. The lowest layer of
mssqlite — everything the TDS wire codecs need to read and write bytes.

Little-endian by default (TDS is little-endian), with explicit `be` variants
where the protocol needs them (e.g. collation sort ids).

## Modules

- `Cursor` — immutable read position over a `Uint8Array` (`of`, `advanced`,
  `remaining`, `end`, `peek`, `slice`). Mirrors `@prelude/parser`'s `Reader`,
  over bytes instead of characters.
- `Result` — decode result (`ok` / `fail` / `failed`), mirrors
  `@prelude/parser`'s `Result`.
- `Read` — decoder type, `Read.t<T> = (cursor: Cursor.t) => Result.t<T>`.
- `Decode` — decoders and combinators.
- `Encode` — pure builders producing `Uint8Array` chunks.
- `Ucs2` — UTF-16LE string encode/decode.
- `Hex` — hex string to bytes and back, whitespace tolerant (handy for tests
  against annotated protocol dumps).

## Decode

Primitives: `uint8`, `int8`, `uint16`, `int16`, `uint16be`, `uint32`, `int32`,
`uint32be`, `uint64`, `int64` (bigint), `float32`, `float64`, `bytes(n)`,
`skip(n)`, `rest`, `ucs2(byteLength)`, `ucs2Chars(charLength)`.

TDS variable-length primitives: `bVarchar` (8-bit char-count prefixed UCS-2),
`usVarchar` (16-bit), `bVarbyte` / `usVarbyte` / `lVarbyte` (8/16/32-bit
byte-count prefixed bytes).

Combinators: `map`, `chain`, `seq`, `times`, `fixed`.

```ts
import { Cursor, Decode, Result } from '@mssqlite/bytes'

const cursor = Cursor.of(bytes)
const result = Decode.seq(Decode.uint8, Decode.usVarchar)(cursor)
if (Result.failed(result)) {
  throw new Error(result.reason)
}
const [ token, text ] = result.value
```

Decoders never throw — failures are values (`Result.Fail` with a reason), and
failed sequences rewind to the original cursor.

## Encode

Every builder returns a fresh `Uint8Array` chunk; compose with `concat`:

```ts
import { Encode } from '@mssqlite/bytes'

const message = Encode.concat(
  Encode.uint8(0xab),
  Encode.usVarchar('hello'),
  Encode.uint32(42)
)
```
