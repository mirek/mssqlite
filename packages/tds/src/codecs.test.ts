import { expect, test } from 'vitest'
import { Cursor, Hex } from '@mssqlite/bytes'
import * as Collation from './collation.ts'
import * as DateTime from './date-time.ts'
import * as Decimal from './decimal.ts'
import * as Guid from './guid.ts'
import * as TypeInfo from './type-info.ts'

test('default collation matches SQL_Latin1_General_CP1_CI_AS wire bytes', () => {
  expect(Collation.encode(Collation.default_)).toEqual(Hex.of('09 04 D0 00 34'))
  expect(Collation.decode(Cursor.of(Hex.of('09 04 D0 00 34')))).toMatchObject({
    value: Collation.default_
  })
})

test('supported sensitivity collations carry distinct TDS flags', () => {
  expect(Array.from(Collation.encode(Collation.ofName('Latin1_General_100_CI_AI'))))
    .toEqual([ 9, 4, 240, 32, 52 ])
  expect(Collation.ofName('Latin1_General_100_CS_AS')).toMatchObject({ flags: 0x0c, version: 2 })
  expect(Collation.ofName('Latin1_General_100_BIN2')).toMatchObject({ flags: 0x20, sortId: 0 })
})

test('guid mixed-endian round trip', () => {
  const guid = '00112233-4455-6677-8899-AABBCCDDEEFF'
  const bytes = Guid.encode(guid)
  expect(bytes).toEqual(Hex.of('33 22 11 00 55 44 77 66 88 99 AA BB CC DD EE FF'))
  expect(Guid.decode(bytes)).toBe(guid)
})

test('decimal encode/decode round trips', () => {
  const cases: [ string, number, number ][] = [
    [ '0', 18, 0 ],
    [ '1', 9, 0 ],
    [ '-1', 9, 0 ],
    [ '123.45', 10, 2 ],
    [ '-123.45', 10, 2 ],
    [ '99999999999999999999999999999999999999', 38, 0 ],
    [ '0.0000001', 18, 7 ]
  ]
  for (const [ text, precision, scale ] of cases) {
    const bytes = Decimal.encode(text, precision, scale)
    expect(bytes.byteLength).toBe(Decimal.length(precision))
    expect(Decimal.decode(bytes, scale)).toBe(text)
  }
})

test('decimal rounds to scale', () => {
  expect(Decimal.decode(Decimal.encode('1.005', 10, 2), 2)).toBe('1.01')
  expect(Decimal.decode(Decimal.encode(1.5, 10, 0), 0)).toBe('2')
  expect(Decimal.decode(Decimal.encode('2e3', 10, 1), 1)).toBe('2000.0')
})

test('decimal precision overflow is rejected before wire truncation', () => {
  expect(() => Decimal.encode('1000', 3, 0)).toThrow(RangeError)
  expect(Array.from(Decimal.encode('-123.45', 5, 2))).toEqual([ 0, 57, 48, 0, 0 ])
  expect(TypeInfo.decimalN(9, 2).maxLength).toBe(5)
  expect(TypeInfo.decimalN(18, 2).maxLength).toBe(9)
  expect(TypeInfo.decimalN(38, 2).maxLength).toBe(17)
})

test('civil date math round trips', () => {
  expect(DateTime.daysFromCivil(1970, 1, 1)).toBe(0)
  expect(DateTime.daysFromCivil(1900, 1, 1)).toBe(-DateTime.epochDays1900)
  expect(DateTime.daysFromCivil(1, 1, 1)).toBe(-DateTime.epochDays0001)
  for (const days of [ -720000, -25567, -1, 0, 1, 19000, 2932896 ]) {
    const civil = DateTime.civilFromDays(days)
    expect(DateTime.daysFromCivil(civil.year, civil.month, civil.day)).toBe(days)
  }
  expect(DateTime.civilFromDays(DateTime.daysFromCivil(2024, 2, 29))).toEqual({
    year: 2024, month: 2, day: 29
  })
})

test('datetime encode/decode round trips', () => {
  expect(DateTime.encodeDateTime(DateTime.partsOf('1900-01-01 00:00:00')))
    .toEqual(Hex.of('00 00 00 00 00 00 00 00'))
  for (const text of [ '1753-01-01 00:00:00.000', '2026-07-01 13:45:30.123', '9999-12-31 23:59:59.000' ]) {
    const parts = DateTime.partsOf(text)
    const bytes = DateTime.encodeDateTime(parts)
    const days = new DataView(bytes.buffer).getInt32(0, true)
    const third = new DataView(bytes.buffer).getUint32(4, true)
    expect(DateTime.decodeDateTime(days, third)).toBe(text)
  }
})

test('smalldatetime rounds seconds to minutes', () => {
  const bytes = DateTime.encodeSmallDateTime(DateTime.partsOf('2026-07-01 13:45:31'))
  const days = new DataView(bytes.buffer).getUint16(0, true)
  const minutes = new DataView(bytes.buffer).getUint16(2, true)
  expect(DateTime.decodeSmallDateTime(days, minutes)).toBe('2026-07-01 13:46:00')
})

test('date round trips', () => {
  for (const text of [ '0001-01-01', '1970-01-01', '2026-07-01', '9999-12-31' ]) {
    const bytes = DateTime.encodeDate(DateTime.partsOf(text))
    expect(bytes.byteLength).toBe(3)
    const days = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16)
    expect(DateTime.decodeDate(days)).toBe(text)
  }
})

test('time scales', () => {
  const parts = DateTime.partsOf('2026-07-01 13:45:30.1234567')
  expect(DateTime.decodeTime(1234567, 7)).toContain('.1234567')
  const bytes7 = DateTime.encodeTime(parts, 7)
  expect(bytes7.byteLength).toBe(5)
  expect(DateTime.encodeTime(parts, 0).byteLength).toBe(3)
  expect(DateTime.encodeTime(parts, 3).byteLength).toBe(4)
})

test('datetimeoffset round trips through UTC shift', () => {
  const parts = DateTime.partsOf('2026-07-01 02:30:00 +05:30')
  expect(parts.offsetMinutes).toBe(330)
  const bytes = DateTime.encodeDateTimeOffset(parts, 0)
  expect(bytes.byteLength).toBe(8)
  const units = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16)
  const days = (bytes[3] ?? 0) | ((bytes[4] ?? 0) << 8) | ((bytes[5] ?? 0) << 16)
  const offset = new DataView(bytes.buffer).getInt16(6, true)
  expect(offset).toBe(330)
  expect(DateTime.decodeDateTimeOffset(units, days, offset, 0)).toBe('2026-07-01 02:30:00 +05:30')
  // UTC stored time is the previous day.
  expect(DateTime.decodeDate(days)).toBe('2026-06-30')
})

test('parses Date objects as UTC', () => {
  const parts = DateTime.partsOf(new Date(Date.UTC(2026, 6, 1, 12, 0, 0, 250)))
  expect(parts).toMatchObject({ year: 2026, month: 7, day: 1, hours: 12, ticks: 2500000 })
})
