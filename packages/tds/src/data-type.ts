/** TDS data type ids. */
export const DataType = {
  // Zero-length (RPC request only).
  nullType: 0x1f,
  // Fixed-length.
  int1: 0x30,
  bit: 0x32,
  int2: 0x34,
  int4: 0x38,
  datetime4: 0x3a,
  float4: 0x3b,
  money: 0x3c,
  datetime: 0x3d,
  float8: 0x3e,
  money4: 0x7a,
  int8: 0x7f,
  // Variable-length, BYTELEN.
  guid: 0x24,
  intN: 0x26,
  bitN: 0x68,
  decimalN: 0x6a,
  numericN: 0x6c,
  floatN: 0x6d,
  moneyN: 0x6e,
  datetimeN: 0x6f,
  dateN: 0x28,
  timeN: 0x29,
  datetime2N: 0x2a,
  datetimeOffsetN: 0x2b,
  // Variable-length, USHORTLEN.
  bigVarbinary: 0xa5,
  bigVarchar: 0xa7,
  bigBinary: 0xad,
  bigChar: 0xaf,
  nvarchar: 0xe7,
  nchar: 0xef,
  // Variable-length, LONGLEN.
  image: 0x22,
  text: 0x23,
  sqlVariant: 0x62,
  ntext: 0x63,
  // Partially length-prefixed (PLP).
  xml: 0xf1,
  udt: 0xf0,
  json: 0xf4
} as const

export type DataType =
  typeof DataType[keyof typeof DataType]

export type t =
  DataType

/** Wire format family determining TYPE_INFO and value layout. */
export type Family =
  | 'fixed'
  | 'byteLen'
  | 'ushortLen'
  | 'longLen'
  | 'plp'
  | 'date'
  | 'scaled'
  | 'decimal'

const families: Record<number, Family> = {
  [DataType.int1]: 'fixed',
  [DataType.bit]: 'fixed',
  [DataType.int2]: 'fixed',
  [DataType.int4]: 'fixed',
  [DataType.datetime4]: 'fixed',
  [DataType.float4]: 'fixed',
  [DataType.money]: 'fixed',
  [DataType.datetime]: 'fixed',
  [DataType.float8]: 'fixed',
  [DataType.money4]: 'fixed',
  [DataType.int8]: 'fixed',
  [DataType.guid]: 'byteLen',
  [DataType.intN]: 'byteLen',
  [DataType.bitN]: 'byteLen',
  [DataType.decimalN]: 'decimal',
  [DataType.numericN]: 'decimal',
  [DataType.floatN]: 'byteLen',
  [DataType.moneyN]: 'byteLen',
  [DataType.datetimeN]: 'byteLen',
  [DataType.dateN]: 'date',
  [DataType.timeN]: 'scaled',
  [DataType.datetime2N]: 'scaled',
  [DataType.datetimeOffsetN]: 'scaled',
  [DataType.bigVarbinary]: 'ushortLen',
  [DataType.bigVarchar]: 'ushortLen',
  [DataType.bigBinary]: 'ushortLen',
  [DataType.bigChar]: 'ushortLen',
  [DataType.nvarchar]: 'ushortLen',
  [DataType.nchar]: 'ushortLen',
  [DataType.image]: 'longLen',
  [DataType.text]: 'longLen',
  [DataType.sqlVariant]: 'longLen',
  [DataType.ntext]: 'longLen',
  [DataType.xml]: 'plp',
  [DataType.udt]: 'plp',
  [DataType.json]: 'plp'
} as const

/** @returns wire format family of a TDS type id, `undefined` for unknown ids. */
export const family =
  (type: number): Family | undefined =>
    families[type]

/** Fixed-length type sizes in bytes. */
export const fixedLength: Record<number, number> = {
  [DataType.int1]: 1,
  [DataType.bit]: 1,
  [DataType.int2]: 2,
  [DataType.int4]: 4,
  [DataType.datetime4]: 4,
  [DataType.float4]: 4,
  [DataType.money]: 8,
  [DataType.datetime]: 8,
  [DataType.float8]: 8,
  [DataType.money4]: 4,
  [DataType.int8]: 8
} as const

/** @returns `true` when the type carries a 5-byte collation in TYPE_INFO. */
export const collated =
  (type: number): boolean =>
    type === DataType.bigChar ||
    type === DataType.bigVarchar ||
    type === DataType.nchar ||
    type === DataType.nvarchar ||
    type === DataType.text ||
    type === DataType.ntext

/** @returns time value byte length for a scale (0-7). */
export const timeLength =
  (scale: number): number =>
    scale <= 2 ?
      3 :
      scale <= 4 ?
        4 :
        5

/** @returns datetime2 value byte length for a scale (0-7) — time plus 3 date bytes. */
export const datetime2Length =
  (scale: number): number =>
    timeLength(scale) + 3

/** @returns datetimeoffset value byte length for a scale (0-7) — datetime2 plus 2 offset bytes. */
export const datetimeOffsetLength =
  (scale: number): number =>
    datetime2Length(scale) + 2
