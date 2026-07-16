import { Cp1252, Cursor, Decode, Encode, Result, Ucs2, type Read } from '@mssqlite/bytes'
import * as DataType from './data-type.ts'
import * as DateTime from './date-time.ts'
import * as Decimal from './decimal.ts'
import * as Guid from './guid.ts'
import * as TypeInfo from './type-info.ts'

/** JS value carried over the wire. */
export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Date

export type t =
  Value

const plpNull = Encode.concat(Encode.uint32(0xffffffff), Encode.uint32(0xffffffff))

/**
 * @throws if an encoded value exceeds what its length prefix can address —
 * a silent modulo wrap would corrupt the whole token stream, so fail loudly
 * (the engine maps this to an MSSQL truncation-style error).
 */
const checkLength =
  (typeInfo: TypeInfo.t, byteLength: number, max: number): void => {
    if (byteLength > max) {
      throw new Error(
        `Value of ${byteLength} bytes exceeds the ${max}-byte limit for type 0x${typeInfo.type.toString(16)}; use a MAX type.`
      )
    }
  }

const number_ =
  (value: Value): number =>
    typeof value === 'number' ?
      value :
      typeof value === 'bigint' ?
        Number(value) :
        typeof value === 'boolean' ?
          (value ? 1 : 0) :
          Number(value)

const intBytes =
  (value: Value, size: number): Uint8Array => {
    switch (size) {
      case 1:
        return Encode.uint8(number_(value))
      case 2:
        return Encode.int16(number_(value))
      case 4:
        return Encode.int32(number_(value))
      default:
        return Encode.int64(typeof value === 'bigint' ? value : BigInt(number_(value)))
    }
  }

const moneyBytes =
  (value: Value, size: number): Uint8Array => {
    const scaled = BigInt(Math.round(number_(value) * 10000))
    if (size === 4) {
      return Encode.int32(Number(scaled))
    }
    const low = BigInt.asUintN(32, scaled)
    const high = BigInt.asIntN(32, scaled >> 32n)
    return Encode.concat(Encode.int32(Number(high)), Encode.uint32(Number(low)))
  }

const stringOf =
  (value: Value): string =>
    typeof value === 'string' ?
      value :
      value instanceof Date ?
        value.toISOString() :
        String(value)

const bytesOf =
  (value: Value): Uint8Array =>
    value instanceof Uint8Array ?
      value :
      Ucs2.encode(stringOf(value))

const parts =
  (value: Value): DateTime.Parts =>
    DateTime.partsOf(value instanceof Date ? value : stringOf(value))

const variantBytes =
  (bytes: Uint8Array): Uint8Array => {
    if (bytes.byteLength < 2) {
      throw new Error('sql_variant payload is shorter than its header.')
    }
    const type = bytes[0] ?? 0
    const properties = bytes[1] ?? 0
    if (bytes.byteLength < properties + 2 || DataType.family(type) === undefined ||
      [ DataType.DataType.sqlVariant, DataType.DataType.xml, DataType.DataType.udt,
        DataType.DataType.image, DataType.DataType.text, DataType.DataType.ntext ]
        .includes(type as never)) {
      throw new Error(`Invalid sql_variant base type 0x${type.toString(16)} or property length.`)
    }
    return Uint8Array.from(bytes)
  }

/** @returns unprefixed payload bytes of a non-null value for its TYPE_INFO. */
export const encodeBare =
  (typeInfo: TypeInfo.t, value: NonNullable<Value>): Uint8Array => {
    const { type } = typeInfo
    switch (type) {
      case DataType.DataType.intN:
      case DataType.DataType.int1:
      case DataType.DataType.int2:
      case DataType.DataType.int4:
      case DataType.DataType.int8:
        return intBytes(value, typeInfo.maxLength ?? DataType.fixedLength[type] ?? 4)
      case DataType.DataType.bitN:
      case DataType.DataType.bit:
        return Encode.uint8(value === true || number_(value) !== 0 ? 1 : 0)
      case DataType.DataType.floatN:
      case DataType.DataType.float4:
      case DataType.DataType.float8:
        return (typeInfo.maxLength ?? DataType.fixedLength[type] ?? 8) === 4 ?
          Encode.float32(number_(value)) :
          Encode.float64(number_(value))
      case DataType.DataType.moneyN:
      case DataType.DataType.money:
      case DataType.DataType.money4:
        return moneyBytes(value, typeInfo.maxLength ?? DataType.fixedLength[type] ?? 8)
      case DataType.DataType.datetimeN:
      case DataType.DataType.datetime:
      case DataType.DataType.datetime4:
        return (typeInfo.maxLength ?? DataType.fixedLength[type] ?? 8) === 4 ?
          DateTime.encodeSmallDateTime(parts(value)) :
          DateTime.encodeDateTime(parts(value))
      case DataType.DataType.dateN:
        return DateTime.encodeDate(parts(value))
      case DataType.DataType.timeN:
        return DateTime.encodeTime(parts(value), typeInfo.scale ?? 7)
      case DataType.DataType.datetime2N:
        return DateTime.encodeDateTime2(parts(value), typeInfo.scale ?? 7)
      case DataType.DataType.datetimeOffsetN:
        return DateTime.encodeDateTimeOffset(parts(value), typeInfo.scale ?? 7)
      case DataType.DataType.decimalN:
      case DataType.DataType.numericN:
        return Decimal.encode(
          typeof value === 'boolean' ? (value ? 1 : 0) : value as string | number | bigint,
          typeInfo.precision ?? 18,
          typeInfo.scale ?? 0
        )
      case DataType.DataType.guid:
        return Guid.encode(stringOf(value))
      case DataType.DataType.nvarchar:
      case DataType.DataType.nchar:
      case DataType.DataType.ntext:
        return Ucs2.encode(stringOf(value))
      case DataType.DataType.bigVarchar:
      case DataType.DataType.bigChar:
      case DataType.DataType.text:
        return Cp1252.encode(stringOf(value))
      case DataType.DataType.bigVarbinary:
      case DataType.DataType.bigBinary:
      case DataType.DataType.image:
      case DataType.DataType.udt:
      case DataType.DataType.sqlVariant:
        return bytesOf(value)
      case DataType.DataType.xml:
      case DataType.DataType.json:
        return Ucs2.encode(stringOf(value))
      default:
        throw new Error(`Cannot encode value for type 0x${type.toString(16)}.`)
    }
  }

/** @returns TYPE_VARBYTE bytes — length-prefixed (or PLP-chunked) value for its TYPE_INFO. */
export const encode =
  (typeInfo: TypeInfo.t, value: Value): Uint8Array => {
    const family = DataType.family(typeInfo.type)
    if (TypeInfo.plp(typeInfo)) {
      if (value === null) {
        return plpNull
      }
      const bare = encodeBare(typeInfo, value)
      return bare.byteLength === 0 ?
        Encode.concat(Encode.uint64(0n), Encode.uint32(0)) :
        Encode.concat(
          Encode.uint64(BigInt(bare.byteLength)),
          Encode.uint32(bare.byteLength),
          bare,
          Encode.uint32(0)
        )
    }
    switch (family) {
      case 'fixed':
        if (value === null) {
          throw new Error(`Fixed type 0x${typeInfo.type.toString(16)} cannot carry NULL.`)
        }
        return encodeBare(typeInfo, value)
      case 'byteLen':
      case 'decimal':
      case 'date':
      case 'scaled': {
        if (value === null) {
          return Encode.uint8(0)
        }
        const bare = encodeBare(typeInfo, value)
        checkLength(typeInfo, bare.byteLength, 0xfe)
        return Encode.concat(Encode.uint8(bare.byteLength), bare)
      }
      case 'ushortLen': {
        if (value === null) {
          return Encode.uint16(0xffff)
        }
        const bare = encodeBare(typeInfo, value)
        checkLength(typeInfo, bare.byteLength, 0xfffe)
        return Encode.concat(Encode.uint16(bare.byteLength), bare)
      }
      case 'longLen': {
        if (value === null) {
          return Encode.uint32(0xffffffff)
        }
        const bare = encodeBare(typeInfo, value)
        return Encode.concat(Encode.uint32(bare.byteLength), bare)
      }
      default:
        throw new Error(`Cannot encode value for type 0x${typeInfo.type.toString(16)}.`)
    }
  }

/** @returns value decoded from unprefixed payload bytes for its TYPE_INFO. */
export const decodeBare =
  (typeInfo: TypeInfo.t, bytes: Uint8Array): Value => {
    const { type } = typeInfo
    let cursor = Cursor.of(bytes)
    const read = <T>(reader: Read.t<T>): T => {
      const result = reader(cursor)
      if (Result.failed(result)) {
        throw new Error(result.reason)
      }
      cursor = result.cursor
      return result.value
    }
    switch (type) {
      case DataType.DataType.intN:
      case DataType.DataType.int1:
      case DataType.DataType.int2:
      case DataType.DataType.int4:
      case DataType.DataType.int8:
        switch (bytes.byteLength) {
          case 1:
            return read(Decode.uint8)
          case 2:
            return read(Decode.int16)
          case 4:
            return read(Decode.int32)
          default:
            return read(Decode.int64)
        }
      case DataType.DataType.bitN:
      case DataType.DataType.bit:
        return read(Decode.uint8) !== 0
      case DataType.DataType.floatN:
      case DataType.DataType.float4:
      case DataType.DataType.float8:
        return bytes.byteLength === 4 ? read(Decode.float32) : read(Decode.float64)
      case DataType.DataType.moneyN:
      case DataType.DataType.money:
      case DataType.DataType.money4: {
        if (bytes.byteLength === 4) {
          return read(Decode.int32) / 10000
        }
        const [ high, low ] = read(Decode.seq(Decode.int32, Decode.uint32))
        return Number((BigInt(high) << 32n) | BigInt(low)) / 10000
      }
      case DataType.DataType.datetimeN:
      case DataType.DataType.datetime:
      case DataType.DataType.datetime4: {
        if (bytes.byteLength === 4) {
          const [ days, minutes ] = read(Decode.seq(Decode.uint16, Decode.uint16))
          return DateTime.decodeSmallDateTime(days, minutes)
        }
        const [ days, third ] = read(Decode.seq(Decode.int32, Decode.uint32))
        return DateTime.decodeDateTime(days, third)
      }
      case DataType.DataType.dateN:
        return DateTime.decodeDate(read(Decode.uintLe(3)))
      case DataType.DataType.timeN: {
        const scale = typeInfo.scale ?? 7
        return DateTime.decodeTime(read(Decode.uintLe(DataType.timeLength(scale))), scale)
      }
      case DataType.DataType.datetime2N: {
        const scale = typeInfo.scale ?? 7
        const units = read(Decode.uintLe(DataType.timeLength(scale)))
        const days = read(Decode.uintLe(3))
        return DateTime.decodeDateTime2(units, days, scale)
      }
      case DataType.DataType.datetimeOffsetN: {
        const scale = typeInfo.scale ?? 7
        const units = read(Decode.uintLe(DataType.timeLength(scale)))
        const days = read(Decode.uintLe(3))
        const offsetMinutes = read(Decode.int16)
        return DateTime.decodeDateTimeOffset(units, days, offsetMinutes, scale)
      }
      case DataType.DataType.decimalN:
      case DataType.DataType.numericN:
        return Decimal.decode(bytes, typeInfo.scale ?? 0)
      case DataType.DataType.guid:
        return Guid.decode(bytes)
      case DataType.DataType.nvarchar:
      case DataType.DataType.nchar:
      case DataType.DataType.ntext:
      case DataType.DataType.xml:
      case DataType.DataType.json:
        return Ucs2.decode(bytes)
      case DataType.DataType.bigVarchar:
      case DataType.DataType.bigChar:
      case DataType.DataType.text:
        return Cp1252.decode(bytes)
      case DataType.DataType.bigVarbinary:
      case DataType.DataType.bigBinary:
      case DataType.DataType.image:
      case DataType.DataType.udt:
        return Uint8Array.from(bytes)
      case DataType.DataType.sqlVariant:
        return variantBytes(bytes)
      default:
        throw new Error(`Cannot decode value for type 0x${type.toString(16)}.`)
    }
  }

const nullValue: Read.t<Value> =
  cursor =>
    Result.ok(cursor, null)

const decodeSized =
  (typeInfo: TypeInfo.t, length: number): Read.t<Value> =>
    cursor => {
      const result = Decode.bytes(length)(cursor)
      if (Result.failed(result)) {
        return result
      }
      // decodeBare throws on a length shorter than its reader needs, or an
      // unhandled type (e.g. sql_variant) — turn that into a decode failure so
      // hostile wire bytes never escape as an uncaught exception.
      try {
        return Result.ok(result.cursor, decodeBare(typeInfo, result.value))
      } catch (error) {
        return Result.fail(cursor, error instanceof Error ? error.message : String(error))
      }
    }

const decodePlp =
  (typeInfo: TypeInfo.t): Read.t<Value> =>
    cursor => {
      const total = Decode.uint64(cursor)
      if (Result.failed(total)) {
        return total
      }
      if (total.value === 0xffffffffffffffffn) {
        return Result.ok(total.cursor, null)
      }
      const chunks: Uint8Array[] = []
      let next = total.cursor
      for (;;) {
        const chunk = Decode.lVarbyte(next)
        if (Result.failed(chunk)) {
          return chunk
        }
        next = chunk.cursor
        if (chunk.value.byteLength === 0) {
          break
        }
        chunks.push(chunk.value)
      }
      try {
        return Result.ok(next, decodeBare(typeInfo, Encode.concat(...chunks)))
      } catch (error) {
        return Result.fail(cursor, error instanceof Error ? error.message : String(error))
      }
    }

/** TYPE_VARBYTE decoder for a TYPE_INFO — produces the JS value (`null` for wire NULLs). */
export const decode =
  (typeInfo: TypeInfo.t): Read.t<Value> =>
    cursor => {
      if (typeInfo.type === DataType.DataType.nullType) {
        return Result.ok(cursor, null)
      }
      const family = DataType.family(typeInfo.type)
      if (TypeInfo.plp(typeInfo)) {
        return decodePlp(typeInfo)(cursor)
      }
      switch (family) {
        case 'fixed':
          return decodeSized(typeInfo, DataType.fixedLength[typeInfo.type] ?? 0)(cursor)
        case 'byteLen':
        case 'decimal':
        case 'date':
        case 'scaled':
          return Decode.chain(Decode.uint8, length =>
            length === 0 ?
              nullValue :
              decodeSized(typeInfo, length))(cursor)
        case 'ushortLen':
          return Decode.chain(Decode.uint16, length =>
            length === 0xffff ?
              nullValue :
              decodeSized(typeInfo, length))(cursor)
        case 'longLen':
          return Decode.chain(Decode.uint32, length =>
            length === 0xffffffff ?
              nullValue :
              decodeSized(typeInfo, length))(cursor)
        default:
          return Result.fail(cursor, `Cannot decode value for type 0x${typeInfo.type.toString(16)}.`)
      }
    }
