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
  readonly collation?: Collation.t,
  readonly xml?: {
    readonly database: string,
    readonly schema: string,
    readonly collection: string
  },
  readonly udt?: {
    readonly maxByteSize: number,
    readonly database: string,
    readonly schema: string,
    readonly name: string,
    readonly assembly: string
  }
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

/** @returns fixed-width binary(n). */
export const binary =
  (maxLength = 1): TypeInfo => ({
    type: DataType.DataType.bigBinary,
    maxLength
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

/** @returns sql_variant, whose value carries its own inner TYPE_INFO. */
export const sqlVariant =
  (): TypeInfo =>
    ({ type: DataType.DataType.sqlVariant, maxLength: 8016 })

/** @returns untyped XML, or XML associated with a schema collection. */
export const xml =
  (schema?: TypeInfo['xml']): TypeInfo => ({
    type: DataType.DataType.xml,
    ...schema === undefined ? {} : { xml: schema }
  })

/** @returns SQL CLR UDT metadata for a PLP-encoded opaque binary value. */
export const udt =
  (name: string, assembly: string, maxByteSize = 0xffff, database = '', schema = 'sys'): TypeInfo => ({
    type: DataType.DataType.udt,
    udt: { maxByteSize, database, schema, name, assembly }
  })

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
        if (type === DataType.DataType.xml) {
          chunks.push(Encode.uint8(typeInfo.xml === undefined ? 0 : 1))
          if (typeInfo.xml !== undefined) {
            chunks.push(
              Encode.bVarchar(typeInfo.xml.database),
              Encode.bVarchar(typeInfo.xml.schema),
              Encode.usVarchar(typeInfo.xml.collection)
            )
          }
        } else if (type === DataType.DataType.udt) {
          if (typeInfo.udt === undefined) {
            throw new Error('UDT TYPE_INFO requires UDT_INFO metadata.')
          }
          chunks.push(
            Encode.uint16(typeInfo.udt.maxByteSize),
            Encode.bVarchar(typeInfo.udt.database),
            Encode.bVarchar(typeInfo.udt.schema),
            Encode.bVarchar(typeInfo.udt.name),
            Encode.usVarchar(typeInfo.udt.assembly)
          )
        }
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

const decodeXml: Read.t<TypeInfo> =
  cursor => Decode.chain(Decode.uint8, present => {
    if (present === 0) {
      return next => Result.ok(next, xml())
    }
    return Decode.map(
      Decode.seq(Decode.bVarchar, Decode.bVarchar, Decode.usVarchar),
      ([ database, schema, collection ]) => xml({ database, schema, collection })
    )
  })(cursor)

const decodeUdt: Read.t<TypeInfo> =
  Decode.map(
    Decode.seq(Decode.uint16, Decode.bVarchar, Decode.bVarchar, Decode.bVarchar, Decode.usVarchar),
    ([ maxByteSize, database, schema, name, assembly ]) =>
      udt(name, assembly, maxByteSize, database, schema)
  )

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
        if (type === DataType.DataType.xml) {
          return decodeXml(type_.cursor)
        }
        if (type === DataType.DataType.udt) {
          return decodeUdt(type_.cursor)
        }
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
