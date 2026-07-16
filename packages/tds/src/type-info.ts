import { Decode, Encode, Result, type Cursor, type Read } from '@mssqlite/bytes'
import * as Collation from './collation.ts'
import * as DataType from './data-type.ts'
import * as Decimal from './decimal.ts'

/** PLP max length marker in USHORTLEN TYPE_INFO. */
export const plpMarker = 0xffff

/** TDS TYPE_INFO — type id with the metadata its family requires. */
export type TypeInfo = {
  readonly type: number,
  /** Max length in bytes (byteLen/ushortLen/longLen families); `0xffff` marks PLP. */
  readonly maxLength?: number,
  readonly precision?: number,
  readonly scale?: number,
  readonly collation?: Collation.t
}

export type t =
  TypeInfo

/** @returns `true` when the type is partially length-prefixed on the wire. */
export const plp =
  (typeInfo: TypeInfo): boolean =>
    DataType.family(typeInfo.type) === 'plp' ||
    (DataType.family(typeInfo.type) === 'ushortLen' && typeInfo.maxLength === plpMarker)

/** @returns nullable intN — tinyint(1), smallint(2), int(4), bigint(8). */
export const intN =
  (maxLength: 1 | 2 | 4 | 8 = 4): TypeInfo =>
    ({ type: DataType.DataType.intN, maxLength })

/** @returns nullable bit. */
export const bitN =
  (): TypeInfo =>
    ({ type: DataType.DataType.bitN, maxLength: 1 })

/** @returns nullable float — real(4) or float(8). */
export const floatN =
  (maxLength: 4 | 8 = 8): TypeInfo =>
    ({ type: DataType.DataType.floatN, maxLength })

/** @returns nullable money — smallmoney(4) or money(8). */
export const moneyN =
  (maxLength: 4 | 8 = 8): TypeInfo =>
    ({ type: DataType.DataType.moneyN, maxLength })

/** @returns nullable datetime — smalldatetime(4) or datetime(8). */
export const datetimeN =
  (maxLength: 4 | 8 = 8): TypeInfo =>
    ({ type: DataType.DataType.datetimeN, maxLength })

/** @returns nvarchar(n) — `maxLength` in characters, `'max'` for nvarchar(max). */
export const nvarchar =
  (maxLength: number | 'max' = 4000, collation: Collation.t = Collation.default_): TypeInfo => ({
    type: DataType.DataType.nvarchar,
    maxLength: maxLength === 'max' ? plpMarker : maxLength * 2,
    collation
  })

/** @returns varchar(n) — `maxLength` in bytes, `'max'` for varchar(max). */
export const varchar =
  (maxLength: number | 'max' = 8000, collation: Collation.t = Collation.default_): TypeInfo => ({
    type: DataType.DataType.bigVarchar,
    maxLength: maxLength === 'max' ? plpMarker : maxLength,
    collation
  })

/** @returns varbinary(n) — `maxLength` in bytes, `'max'` for varbinary(max). */
export const varbinary =
  (maxLength: number | 'max' = 8000): TypeInfo => ({
    type: DataType.DataType.bigVarbinary,
    maxLength: maxLength === 'max' ? plpMarker : maxLength
  })

/** @returns nullable decimal(p, s). */
export const decimalN =
  (precision = 18, scale = 0): TypeInfo => ({
    type: DataType.DataType.decimalN,
    maxLength: Decimal.length(precision),
    precision,
    scale
  })

/** @returns nullable uniqueidentifier. */
export const guid =
  (): TypeInfo =>
    ({ type: DataType.DataType.guid, maxLength: 16 })

/** @returns nullable date. */
export const dateN =
  (): TypeInfo =>
    ({ type: DataType.DataType.dateN })

/** @returns nullable time(scale). */
export const timeN =
  (scale = 7): TypeInfo =>
    ({ type: DataType.DataType.timeN, scale })

/** @returns nullable datetime2(scale). */
export const datetime2N =
  (scale = 7): TypeInfo =>
    ({ type: DataType.DataType.datetime2N, scale })

/** @returns nullable datetimeoffset(scale). */
export const datetimeOffsetN =
  (scale = 7): TypeInfo =>
    ({ type: DataType.DataType.datetimeOffsetN, scale })

/** @returns TYPE_INFO wire bytes. */
export const encode =
  (typeInfo: TypeInfo): Uint8Array => {
    const { type } = typeInfo
    const family = DataType.family(type)
    const chunks: Uint8Array[] = [ Encode.uint8(type) ]
    switch (family) {
      case 'fixed':
      case 'date':
        break
      case 'byteLen':
        chunks.push(Encode.uint8(typeInfo.maxLength ?? 0))
        break
      case 'decimal':
        chunks.push(
          Encode.uint8(typeInfo.maxLength ?? 17),
          Encode.uint8(typeInfo.precision ?? 18),
          Encode.uint8(typeInfo.scale ?? 0)
        )
        break
      case 'scaled':
        chunks.push(Encode.uint8(typeInfo.scale ?? 7))
        break
      case 'ushortLen':
        chunks.push(Encode.uint16(typeInfo.maxLength ?? 0))
        break
      case 'longLen':
        chunks.push(Encode.uint32(typeInfo.maxLength ?? 0))
        break
      case 'plp':
        break
      default:
        throw new Error(`Cannot encode TYPE_INFO for type 0x${type.toString(16)}.`)
    }
    if (DataType.collated(type)) {
      chunks.push(Collation.encode(typeInfo.collation ?? Collation.default_))
    }
    return Encode.concat(...chunks)
  }

const withCollation =
  (typeInfo: TypeInfo, cursor: Cursor.t): Result.t<TypeInfo> =>
    DataType.collated(typeInfo.type) ?
      Decode.map(Collation.decode, collation => ({ ...typeInfo, collation }))(cursor) :
      Result.ok(cursor, typeInfo)

/** TYPE_INFO decoder. */
export const decode: Read.t<TypeInfo> =
  (cursor: Cursor.t): Result.t<TypeInfo> => {
    const type_ = Decode.uint8(cursor)
    if (Result.failed(type_)) {
      return type_
    }
    const type = type_.value
    if (type === DataType.DataType.nullType) {
      return Result.ok(type_.cursor, { type })
    }
    const family = DataType.family(type)
    switch (family) {
      case 'fixed':
      case 'date':
      case 'plp':
        return withCollation({ type }, type_.cursor)
      case 'byteLen':
        return Decode.chain(Decode.uint8, maxLength =>
          next => withCollation({ type, maxLength }, next))(type_.cursor)
      case 'decimal':
        return Decode.map(
          Decode.seq(Decode.uint8, Decode.uint8, Decode.uint8),
          ([ maxLength, precision, scale ]) => ({ type, maxLength, precision, scale })
        )(type_.cursor)
      case 'scaled':
        return Decode.map(Decode.uint8, scale => ({ type, scale }))(type_.cursor)
      case 'ushortLen':
        return Decode.chain(Decode.uint16, maxLength =>
          next => withCollation({ type, maxLength }, next))(type_.cursor)
      case 'longLen':
        return Decode.chain(Decode.uint32, maxLength =>
          next => withCollation({ type, maxLength }, next))(type_.cursor)
      case undefined:
        return Result.fail(cursor, `Unsupported TYPE_INFO type 0x${type.toString(16)}.`)
      default:
        return Result.fail(cursor, `Unsupported TYPE_INFO family ${family}.`)
    }
  }
