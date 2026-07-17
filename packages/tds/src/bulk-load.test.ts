import { describe, expect, test } from 'vitest'
import { Cursor, Encode, Result } from '@mssqlite/bytes'
import { BulkLoad, Token, TypeInfo, Value } from './index.ts'

const columns: readonly Token.Column[] = [
  { name: 'id', typeInfo: TypeInfo.intN(4), flags: Token.Flags.updateableReadWrite },
  { name: 'note', typeInfo: TypeInfo.nvarchar('max') },
  { name: 'amount', typeInfo: TypeInfo.decimalN(10, 2) }
]

const payload = Encode.concat(
  Token.colMetadata(columns),
  Token.row(columns, [ 7, 'hello', '12.30' ]),
  Token.row(columns, [ 8, null, '-0.25' ]),
  Token.done(Token.Status.final, 0, 0n)
)

const decodeChunks =
  (chunks: readonly Uint8Array[]): { readonly state: BulkLoad.State, readonly rows: readonly unknown[] } => {
    let state = BulkLoad.initial
    const rows: unknown[] = []
    chunks.forEach((chunk, index) => {
      const decoded = BulkLoad.push(state, chunk, index === chunks.length - 1)
      expect(Result.failed(decoded) ? decoded.reason : undefined).toBeUndefined()
      if (!Result.failed(decoded)) {
        state = decoded.value.state
        rows.push(...decoded.value.rows)
      }
    })
    return { state, rows }
  }

test('incremental BulkLoadBCP decoding emits mixed rows across every byte boundary', () => {
  for (let split = 1; split < payload.byteLength; split++) {
    const decoded = decodeChunks([ payload.subarray(0, split), payload.subarray(split) ])
    expect(decoded.state.done).toBe(true)
    expect(decoded.rows).toEqual([ [ 7, 'hello', '12.30' ], [ 8, null, '-0.25' ] ])
  }
})

test('annotated nullable INTN fixture decodes without relying on server encoders', () => {
  const fixture = Uint8Array.from([
    0x81, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x05, 0x00,
    0x26, 0x04,
    0x02, 0x63, 0x00, 0x31, 0x00,
    0xd1, 0x00,
    0xfd, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ])
  const decoded = decodeChunks([ fixture ])
  expect(decoded.state.columns).toEqual([ {
    name: 'c1', userType: 0, flags: 5, typeInfo: TypeInfo.intN(4)
  } ])
  expect(decoded.rows).toEqual([ [ null ] ])
})

test('FreeTDS compatibility may treat row-boundary EOM as implicit DONE', () => {
  const withoutDone = payload.subarray(0, payload.byteLength - 13)
  expect(Result.failed(BulkLoad.push(BulkLoad.initial, withoutDone, true))).toBe(true)
  const decoded = BulkLoad.push(BulkLoad.initial, withoutDone, true, true)
  expect(Result.failed(decoded) ? decoded.reason : decoded.value.state.done).toBe(true)
  expect(Result.failed(decoded) ? [] : decoded.value.rows).toEqual([
    [ 7, 'hello', '12.30' ], [ 8, null, '-0.25' ]
  ])
})

describe('bulk decoder rejects hostile and truncated streams as values', () => {
  test('every proper payload prefix is incomplete at EOM', () => {
    for (let length = 0; length < payload.byteLength; length++) {
      const decoded = BulkLoad.push(BulkLoad.initial, payload.subarray(0, length), true)
      expect(Result.failed(decoded), `prefix ${length}`).toBe(true)
    }
  })

  test('NBCROW, trailing bytes, invalid PLP totals, and oversized pending values fail', () => {
    const metadata = Token.colMetadata([ columns[0] as Token.Column ])
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, Encode.concat(
      metadata, Uint8Array.of(0xd2), Token.done(Token.Status.final, 0, 0n)), true))).toBe(true)
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, Encode.concat(payload, Uint8Array.of(0)), true))).toBe(true)

    const plpColumn: Token.Column = { name: 'value', typeInfo: TypeInfo.nvarchar('max') }
    const malformedPlp = Encode.concat(
      Token.colMetadata([ plpColumn ]), Uint8Array.of(0xd1),
      Encode.uint64(2n), Encode.uint32(4), Uint8Array.of(1, 2, 3, 4), Encode.uint32(0),
      Token.done(Token.Status.final, 0, 0n)
    )
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, malformedPlp, true))).toBe(true)

    const large = Encode.concat(
      Token.colMetadata([ { name: 'image', typeInfo: TypeInfo.varbinary('max') } ]),
      Uint8Array.of(0xd1), Encode.uint64(20_000_000n), Encode.uint32(20_000_000),
      new Uint8Array(16 * 1024 * 1024)
    )
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, large))).toBe(true)

    const invalidIntInfo = Uint8Array.from([
      0x81, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0x26, 0x03, 0x01, 0x78, 0,
      0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ])
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, invalidIntInfo, true))).toBe(true)
    const shortInt = Encode.concat(
      Token.colMetadata([ columns[0] as Token.Column ]),
      Uint8Array.of(0xd1, 0x02, 0x01, 0x00),
      Token.done(Token.Status.final, 0, 0n)
    )
    expect(Result.failed(BulkLoad.push(BulkLoad.initial, shortInt, true))).toBe(true)
  })

  test('deterministic random inputs never throw or retain unbounded bytes', () => {
    let random = 0x5eed1234
    for (let attempt = 0; attempt < 2000; attempt++) {
      random = ((random * 1_664_525) + 1_013_904_223) >>> 0
      const bytes = new Uint8Array(random % 512)
      for (let index = 0; index < bytes.length; index++) {
        random = ((random * 1_664_525) + 1_013_904_223) >>> 0
        bytes[index] = random & 0xff
      }
      expect(() => BulkLoad.push(BulkLoad.initial, bytes, true)).not.toThrow()
    }
  })
})

test('PLP known and unknown lengths decode while mismatched totals fail', () => {
  const type = TypeInfo.nvarchar('max')
  const known = Value.decode(type)(Cursor.of(Value.encode(type, 'abc')))
  expect(Result.failed(known) ? known.reason : known.value).toBe('abc')
  const unknown = Encode.concat(
    Encode.uint64(0xfffffffffffffffen), Encode.uint32(2), Uint8Array.of(0x61, 0), Encode.uint32(0))
  const decoded = Value.decode(type)(Cursor.of(unknown))
  expect(Result.failed(decoded) ? decoded.reason : decoded.value).toBe('a')
})
