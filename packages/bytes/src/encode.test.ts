import { expect, test } from 'vitest'
import * as Encode from './encode.ts'
import * as Hex from './hex.ts'

test('numbers', () => {
  expect(Encode.uint8(0x01)).toEqual(Hex.of('01'))
  expect(Encode.uint16(0x0201)).toEqual(Hex.of('01 02'))
  expect(Encode.uint16be(0x0102)).toEqual(Hex.of('01 02'))
  expect(Encode.uint32(0x04030201)).toEqual(Hex.of('01 02 03 04'))
  expect(Encode.uint32be(0x01020304)).toEqual(Hex.of('01 02 03 04'))
  expect(Encode.uint64(0x0807060504030201n)).toEqual(Hex.of('01 02 03 04 05 06 07 08'))
  expect(Encode.uint64(1)).toEqual(Hex.of('01 00 00 00 00 00 00 00'))
  expect(Encode.int8(-1)).toEqual(Hex.of('ff'))
  expect(Encode.int16(-1)).toEqual(Hex.of('ff ff'))
  expect(Encode.int32(-1)).toEqual(Hex.of('ff ff ff ff'))
  expect(Encode.int64(-1n)).toEqual(Hex.of('ff ff ff ff ff ff ff ff'))
  expect(Encode.float64(1)).toEqual(Hex.of('00 00 00 00 00 00 f0 3f'))
  expect(Encode.float32(1)).toEqual(Hex.of('00 00 80 3f'))
})

test('concat', () => {
  expect(Encode.concat(Hex.of('01'), Hex.of(''), Hex.of('02 03'))).toEqual(Hex.of('01 02 03'))
  expect(Encode.concat()).toEqual(new Uint8Array(0))
})

test('ucs2', () => {
  expect(Encode.ucs2('abc')).toEqual(Hex.of('61 00 62 00 63 00'))
  expect(Encode.ucs2('')).toEqual(new Uint8Array(0))
})

test('varchar', () => {
  expect(Encode.bVarchar('hi')).toEqual(Hex.of('02 68 00 69 00'))
  expect(Encode.usVarchar('hi')).toEqual(Hex.of('02 00 68 00 69 00'))
})

test('varbyte', () => {
  expect(Encode.bVarbyte(Hex.of('aa bb'))).toEqual(Hex.of('02 aa bb'))
  expect(Encode.usVarbyte(Hex.of('aa bb'))).toEqual(Hex.of('02 00 aa bb'))
  expect(Encode.lVarbyte(Hex.of('aa bb'))).toEqual(Hex.of('02 00 00 00 aa bb'))
})

test('hex round trip', () => {
  expect(Hex.string(Hex.of('de ad be ef'))).toBe('deadbeef')
})
