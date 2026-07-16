import { Cursor, Encode, Result } from '@mssqlite/bytes'
import * as Collation from './collation.ts'
import * as DataType from './data-type.ts'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

export type Decoded = {
  readonly typeInfo: TypeInfo.t,
  readonly value: Exclude<Value.t, null>
}

const fixedType =
  (typeInfo: TypeInfo.t): number => {
    switch (typeInfo.type) {
      case DataType.DataType.intN:
        return typeInfo.maxLength === 1 ? DataType.DataType.int1 :
          typeInfo.maxLength === 2 ? DataType.DataType.int2 :
            typeInfo.maxLength === 8 ? DataType.DataType.int8 : DataType.DataType.int4
      case DataType.DataType.bitN:
        return DataType.DataType.bit
      case DataType.DataType.floatN:
        return typeInfo.maxLength === 4 ? DataType.DataType.float4 : DataType.DataType.float8
      case DataType.DataType.moneyN:
        return typeInfo.maxLength === 4 ? DataType.DataType.money4 : DataType.DataType.money
      case DataType.DataType.datetimeN:
        return typeInfo.maxLength === 4 ? DataType.DataType.datetime4 : DataType.DataType.datetime
      default:
        return typeInfo.type
    }
  }

const properties =
  (typeInfo: TypeInfo.t): Uint8Array => {
    switch (typeInfo.type) {
      case DataType.DataType.decimalN:
      case DataType.DataType.numericN:
        return Encode.concat(
          Encode.uint8(typeInfo.precision ?? 18),
          Encode.uint8(typeInfo.scale ?? 0)
        )
      case DataType.DataType.bigVarbinary:
      case DataType.DataType.bigBinary:
        return Encode.uint16(typeInfo.maxLength ?? 8000)
      case DataType.DataType.bigVarchar:
      case DataType.DataType.bigChar:
      case DataType.DataType.nvarchar:
      case DataType.DataType.nchar:
        return Encode.concat(
          Collation.encode(typeInfo.collation ?? Collation.default_),
          Encode.uint16(typeInfo.maxLength ?? 8000)
        )
      case DataType.DataType.timeN:
      case DataType.DataType.datetime2N:
      case DataType.DataType.datetimeOffsetN:
        return Encode.uint8(typeInfo.scale ?? 7)
      default:
        return new Uint8Array()
    }
  }

/** @returns an SSVARIANT_INSTANCE preserving the supplied base type metadata. */
export const encode =
  (typeInfo: TypeInfo.t, value: Exclude<Value.t, null>): Uint8Array => {
    if ([ DataType.DataType.sqlVariant, DataType.DataType.xml, DataType.DataType.udt,
      DataType.DataType.image, DataType.DataType.text, DataType.DataType.ntext ]
      .includes(typeInfo.type as never)) {
      throw new Error('The selected base type cannot be stored in sql_variant.')
    }
    const props = properties(typeInfo)
    return Encode.concat(
      Encode.uint8(fixedType(typeInfo)),
      Encode.uint8(props.byteLength),
      props,
      Value.encodeBare(typeInfo, value)
    )
  }

const typeInfoOf =
  (type: number, props: Uint8Array): TypeInfo.t => {
    const view = new DataView(props.buffer, props.byteOffset, props.byteLength)
    switch (type) {
      case DataType.DataType.int1:
      case DataType.DataType.int2:
      case DataType.DataType.int4:
      case DataType.DataType.int8:
      case DataType.DataType.bit:
      case DataType.DataType.float4:
      case DataType.DataType.float8:
      case DataType.DataType.money:
      case DataType.DataType.money4:
      case DataType.DataType.datetime:
      case DataType.DataType.datetime4:
      case DataType.DataType.guid:
      case DataType.DataType.dateN:
        return { type }
      case DataType.DataType.decimalN:
      case DataType.DataType.numericN:
        return { type, precision: props[0] ?? 18, scale: props[1] ?? 0 }
      case DataType.DataType.bigVarbinary:
      case DataType.DataType.bigBinary:
        return { type, maxLength: view.getUint16(0, true) }
      case DataType.DataType.bigVarchar:
      case DataType.DataType.bigChar:
      case DataType.DataType.nvarchar:
      case DataType.DataType.nchar: {
        const decoded = Collation.decode(Cursor.of(props))
        if (Result.failed(decoded)) {
          throw new Error(decoded.reason)
        }
        return { type, collation: decoded.value, maxLength: view.getUint16(5, true) }
      }
      case DataType.DataType.timeN:
      case DataType.DataType.datetime2N:
      case DataType.DataType.datetimeOffsetN:
        return { type, scale: props[0] ?? 7 }
      default:
        throw new Error(`Unsupported sql_variant base type 0x${type.toString(16)}.`)
    }
  }

/** Decodes an SSVARIANT_INSTANCE into its base metadata and value. */
export const decode =
  (bytes: Uint8Array): Decoded => {
    if (bytes.byteLength < 2) {
      throw new Error('sql_variant payload is shorter than its header.')
    }
    const type = bytes[0] ?? 0
    const propLength = bytes[1] ?? 0
    if (bytes.byteLength < 2 + propLength) {
      throw new Error('sql_variant properties exceed the payload length.')
    }
    const typeInfo = typeInfoOf(type, bytes.subarray(2, 2 + propLength))
    const value = Value.decodeBare(typeInfo, bytes.subarray(2 + propLength))
    if (value === null) {
      throw new Error('A non-null sql_variant cannot contain NULL.')
    }
    return { typeInfo, value }
  }
