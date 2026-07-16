import { expect, test } from 'vitest'
import { Cursor, Hex, Result } from '@mssqlite/bytes'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

const roundTrip =
  (typeInfo: TypeInfo.t, value: Value.t): Value.t => {
    const bytes = Value.encode(typeInfo, value)
    const result = Value.decode(typeInfo)(Cursor.of(bytes))
    if (Result.failed(result)) {
      throw new Error(result.reason)
    }
    expect(result.cursor.offset).toBe(bytes.byteLength)
    return result.value
  }

test('intN round trips', () => {
  expect(roundTrip(TypeInfo.intN(1), 255)).toBe(255)
  expect(roundTrip(TypeInfo.intN(2), -32768)).toBe(-32768)
  expect(roundTrip(TypeInfo.intN(4), 2147483647)).toBe(2147483647)
  expect(roundTrip(TypeInfo.intN(8), 9007199254740993n)).toBe(9007199254740993n)
  expect(roundTrip(TypeInfo.intN(4), null)).toBeNull()
})

test('bitN round trips', () => {
  expect(roundTrip(TypeInfo.bitN(), true)).toBe(true)
  expect(roundTrip(TypeInfo.bitN(), false)).toBe(false)
  expect(roundTrip(TypeInfo.bitN(), null)).toBeNull()
})

test('floatN round trips', () => {
  expect(roundTrip(TypeInfo.floatN(8), 1.5)).toBe(1.5)
  expect(roundTrip(TypeInfo.floatN(4), 0.5)).toBe(0.5)
  expect(roundTrip(TypeInfo.floatN(8), null)).toBeNull()
})

test('moneyN round trips', () => {
  expect(roundTrip(TypeInfo.moneyN(8), 123.4567)).toBe(123.4567)
  expect(roundTrip(TypeInfo.moneyN(8), -1)).toBe(-1)
  expect(roundTrip(TypeInfo.moneyN(4), 21.4748)).toBe(21.4748)
})

test('nvarchar round trips', () => {
  expect(roundTrip(TypeInfo.nvarchar(10), 'héllo')).toBe('héllo')
  expect(roundTrip(TypeInfo.nvarchar(10), '')).toBe('')
  expect(roundTrip(TypeInfo.nvarchar(10), null)).toBeNull()
})

test('nvarchar(max) uses PLP encoding', () => {
  const long = 'x'.repeat(5000)
  expect(roundTrip(TypeInfo.nvarchar('max'), long)).toBe(long)
  expect(roundTrip(TypeInfo.nvarchar('max'), null)).toBeNull()
  expect(roundTrip(TypeInfo.nvarchar('max'), '')).toBe('')
  const nullBytes = Value.encode(TypeInfo.nvarchar('max'), null)
  expect(nullBytes).toEqual(Hex.of('ff ff ff ff ff ff ff ff'))
})

test('varchar round trips as CP1252', () => {
  expect(roundTrip(TypeInfo.varchar(10), 'foo')).toBe('foo')
  const bytes = Value.encode(TypeInfo.varchar(10), 'foo')
  expect(bytes).toEqual(Hex.of('03 00 66 6f 6f'))
})

test('varchar encodes Windows-1252 specials, not latin1', () => {
  // '€' is byte 0x80 in CP1252; latin1 would corrupt it. '—' is 0x97.
  expect(roundTrip(TypeInfo.varchar(20), 'price €99 — ok')).toBe('price €99 — ok')
  const euro = Value.encode(TypeInfo.varchar(1), '€')
  expect(euro).toEqual(Hex.of('01 00 80'))
})

test('varbinary round trips', () => {
  expect(roundTrip(TypeInfo.varbinary(10), Hex.of('de ad'))).toEqual(Hex.of('de ad'))
  expect(roundTrip(TypeInfo.varbinary('max'), Hex.of('01 02 03'))).toEqual(Hex.of('01 02 03'))
  expect(roundTrip(TypeInfo.varbinary(10), null)).toBeNull()
})

test('guid round trips', () => {
  const guid = 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'
  expect(roundTrip(TypeInfo.guid(), guid)).toBe(guid)
  expect(roundTrip(TypeInfo.guid(), null)).toBeNull()
})

test('decimal round trips', () => {
  expect(roundTrip(TypeInfo.decimalN(18, 2), '42.50')).toBe('42.50')
  expect(roundTrip(TypeInfo.decimalN(18, 0), 7)).toBe('7')
  expect(roundTrip(TypeInfo.decimalN(18, 2), null)).toBeNull()
})

test('datetime family round trips', () => {
  expect(roundTrip(TypeInfo.datetimeN(8), '2026-07-01 13:45:30.123')).toBe('2026-07-01 13:45:30.123')
  expect(roundTrip(TypeInfo.datetimeN(4), '2026-07-01 13:45:00')).toBe('2026-07-01 13:45:00')
  expect(roundTrip(TypeInfo.dateN(), '2026-07-01')).toBe('2026-07-01')
  expect(roundTrip(TypeInfo.timeN(7), '13:45:30.1234567')).toBe('13:45:30.1234567')
  expect(roundTrip(TypeInfo.datetime2N(7), '2026-07-01 13:45:30.1234567')).toBe('2026-07-01 13:45:30.1234567')
  expect(roundTrip(TypeInfo.datetime2N(3), '2026-07-01 13:45:30.123')).toBe('2026-07-01 13:45:30.123')
  expect(roundTrip(TypeInfo.datetimeOffsetN(0), '2026-07-01 02:30:00 +05:30')).toBe('2026-07-01 02:30:00 +05:30')
  expect(roundTrip(TypeInfo.datetimeOffsetN(7), '2026-07-01 02:30:00.1234567 +05:30'))
    .toBe('2026-07-01 02:30:00.1234567 +05:30')
  expect(roundTrip(TypeInfo.datetimeN(8), null)).toBeNull()
  expect(roundTrip(TypeInfo.dateN(), null)).toBeNull()
})

test('dates encode from Date objects', () => {
  expect(roundTrip(TypeInfo.datetime2N(3), new Date(Date.UTC(2026, 6, 1, 12, 30, 15, 250))))
    .toBe('2026-07-01 12:30:15.250')
})

test('type info encode/decode round trips', () => {
  const infos: TypeInfo.t[] = [
    TypeInfo.intN(4),
    TypeInfo.bitN(),
    TypeInfo.floatN(8),
    TypeInfo.nvarchar(100),
    TypeInfo.nvarchar('max'),
    TypeInfo.varchar(10),
    TypeInfo.varbinary('max'),
    TypeInfo.decimalN(18, 4),
    TypeInfo.guid(),
    TypeInfo.dateN(),
    TypeInfo.timeN(3),
    TypeInfo.datetime2N(7),
    TypeInfo.datetimeOffsetN(2),
    TypeInfo.moneyN(8),
    TypeInfo.datetimeN(8)
  ]
  for (const info of infos) {
    const bytes = TypeInfo.encode(info)
    const result = TypeInfo.decode(Cursor.of(bytes))
    expect(Result.failed(result)).toBe(false)
    expect(result.value).toMatchObject({ type: info.type })
    expect(result.cursor?.offset).toBe(bytes.byteLength)
  }
})

test('nvarchar type info matches spec wire format', () => {
  expect(TypeInfo.encode(TypeInfo.varchar(3)))
    .toEqual(Hex.of('A7 03 00 09 04 D0 00 34'))
})
