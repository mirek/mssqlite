import { expect, test } from 'vitest'
import * as Cursor from './cursor.ts'
import * as Decode from './decode.ts'
import * as Hex from './hex.ts'
import * as Result from './result.ts'

test('numbers', () => {
  const cursor = Cursor.of(Hex.of('01 02 03 04 05 06 07 08'))
  expect(Decode.uint8(cursor)).toMatchObject({ value: 0x01 })
  expect(Decode.uint16(cursor)).toMatchObject({ value: 0x0201 })
  expect(Decode.uint16be(cursor)).toMatchObject({ value: 0x0102 })
  expect(Decode.uint32(cursor)).toMatchObject({ value: 0x04030201 })
  expect(Decode.uint32be(cursor)).toMatchObject({ value: 0x01020304 })
  expect(Decode.uint64(cursor)).toMatchObject({ value: 0x0807060504030201n })
})

test('signed numbers', () => {
  const cursor = Cursor.of(Hex.of('ff ff ff ff ff ff ff ff'))
  expect(Decode.int8(cursor)).toMatchObject({ value: -1 })
  expect(Decode.int16(cursor)).toMatchObject({ value: -1 })
  expect(Decode.int32(cursor)).toMatchObject({ value: -1 })
  expect(Decode.int64(cursor)).toMatchObject({ value: -1n })
})

test('floats', () => {
  const cursor64 = Cursor.of(Hex.of('00 00 00 00 00 00 f0 3f'))
  expect(Decode.float64(cursor64)).toMatchObject({ value: 1 })
  const cursor32 = Cursor.of(Hex.of('00 00 80 3f'))
  expect(Decode.float32(cursor32)).toMatchObject({ value: 1 })
})

test('out of bounds fails', () => {
  const cursor = Cursor.of(Hex.of('01'))
  const result = Decode.uint16(cursor)
  expect(Result.failed(result)).toBe(true)
})

test('cursor advances', () => {
  const cursor = Cursor.of(Hex.of('01 02 03 04'))
  const first = Decode.uint16(cursor)
  expect(Result.failed(first)).toBe(false)
  const second = Decode.uint16(first.cursor)
  expect(second).toMatchObject({ value: 0x0403 })
})

test('bytes and rest share the underlying buffer', () => {
  const source = Hex.of('01 02 03 04')
  const cursor = Cursor.of(source, 1)
  const result = Decode.bytes(2)(cursor)
  expect(Result.failed(result)).toBe(false)
  expect(Array.from(result.value ?? [])).toEqual([ 0x02, 0x03 ])
  expect(Decode.rest(result.cursor ?? cursor)).toMatchObject({ value: Hex.of('04') })
})

test('ucs2', () => {
  const cursor = Cursor.of(Hex.of('61 00 62 00 63 00'))
  expect(Decode.ucs2(6)(cursor)).toMatchObject({ value: 'abc' })
  expect(Decode.ucs2Chars(2)(cursor)).toMatchObject({ value: 'ab' })
})

test('varchar', () => {
  const bCursor = Cursor.of(Hex.of('02 68 00 69 00'))
  expect(Decode.bVarchar(bCursor)).toMatchObject({ value: 'hi' })
  const usCursor = Cursor.of(Hex.of('02 00 68 00 69 00'))
  expect(Decode.usVarchar(usCursor)).toMatchObject({ value: 'hi' })
})

test('varbyte', () => {
  const bCursor = Cursor.of(Hex.of('02 aa bb'))
  expect(Decode.bVarbyte(bCursor)).toMatchObject({ value: Hex.of('aa bb') })
  const usCursor = Cursor.of(Hex.of('02 00 aa bb'))
  expect(Decode.usVarbyte(usCursor)).toMatchObject({ value: Hex.of('aa bb') })
  const lCursor = Cursor.of(Hex.of('02 00 00 00 aa bb'))
  expect(Decode.lVarbyte(lCursor)).toMatchObject({ value: Hex.of('aa bb') })
})

test('seq', () => {
  const cursor = Cursor.of(Hex.of('01 02 00 03 00 00 00'))
  const result = Decode.seq(Decode.uint8, Decode.uint16, Decode.uint32)(cursor)
  expect(result).toMatchObject({ value: [ 1, 2, 3 ] })
})

test('seq resets cursor on failure', () => {
  const cursor = Cursor.of(Hex.of('01'))
  const result = Decode.seq(Decode.uint8, Decode.uint8)(cursor)
  expect(Result.failed(result)).toBe(true)
  expect(result.cursor.offset).toBe(0)
})

test('times', () => {
  const cursor = Cursor.of(Hex.of('01 02 03'))
  expect(Decode.times(3, Decode.uint8)(cursor)).toMatchObject({ value: [ 1, 2, 3 ] })
  expect(Result.failed(Decode.times(4, Decode.uint8)(cursor))).toBe(true)
})

test('map and chain', () => {
  const cursor = Cursor.of(Hex.of('02 61 00 62 00'))
  const read = Decode.chain(Decode.uint8, length => Decode.ucs2Chars(length))
  expect(read(cursor)).toMatchObject({ value: 'ab' })
  expect(Decode.map(Decode.uint8, value => value * 10)(cursor)).toMatchObject({ value: 20 })
})

test('skip', () => {
  const cursor = Cursor.of(Hex.of('01 02 03'))
  const result = Decode.skip(2)(cursor)
  expect(Result.failed(result)).toBe(false)
  expect(result.cursor.offset).toBe(2)
})
