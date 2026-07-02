import type { TypeName } from '@mssqlite/tsql'

/** Type category driving affinity, collation and cast behavior. */
export type Category =
  | 'integer'
  | 'real'
  | 'decimal'
  | 'text'
  | 'ntext'
  | 'blob'
  | 'date'
  | 'time'
  | 'datetime'
  | 'guid'
  | 'bit'
  | 'variant'

const categories: Record<string, Category> = {
  tinyint: 'integer',
  smallint: 'integer',
  int: 'integer',
  integer: 'integer',
  bigint: 'integer',
  bit: 'bit',
  decimal: 'decimal',
  numeric: 'decimal',
  dec: 'decimal',
  money: 'decimal',
  smallmoney: 'decimal',
  float: 'real',
  real: 'real',
  'double precision': 'real',
  char: 'text',
  varchar: 'text',
  'character varying': 'text',
  character: 'text',
  text: 'text',
  nchar: 'ntext',
  nvarchar: 'ntext',
  'national character': 'ntext',
  'national char': 'ntext',
  'national character varying': 'ntext',
  'national char varying': 'ntext',
  'national text': 'ntext',
  ntext: 'ntext',
  sysname: 'ntext',
  binary: 'blob',
  varbinary: 'blob',
  image: 'blob',
  rowversion: 'blob',
  timestamp: 'blob',
  date: 'date',
  time: 'time',
  smalldatetime: 'datetime',
  datetime: 'datetime',
  datetime2: 'datetime',
  datetimeoffset: 'datetime',
  uniqueidentifier: 'guid',
  sql_variant: 'variant',
  xml: 'ntext',
  json: 'ntext'
} as const

/** @returns type category, `undefined` for unknown type names. */
export const category =
  (type: TypeName.t): Category | undefined =>
    categories[type.name]

/**
 * @returns SQLite column type for CREATE TABLE — character types collate
 * NOCASE to approximate MSSQL's default case-insensitive collation.
 */
export const columnType =
  (type: TypeName.t): string => {
    switch (category(type)) {
      case 'integer':
      case 'bit':
        return 'INTEGER'
      case 'real':
        return 'REAL'
      case 'decimal':
        return 'NUMERIC'
      case 'text':
      case 'ntext':
        return 'TEXT COLLATE NOCASE'
      case 'blob':
        return 'BLOB'
      case 'date':
      case 'time':
      case 'datetime':
        return 'TEXT'
      case 'guid':
        return 'TEXT COLLATE NOCASE'
      default:
        return ''
    }
  }

/** @returns SQLite CAST target affinity for a T-SQL type. */
export const castType =
  (type: TypeName.t): string => {
    switch (category(type)) {
      case 'integer':
      case 'bit':
        return 'INTEGER'
      case 'real':
        return 'REAL'
      case 'decimal':
        return 'NUMERIC'
      case 'blob':
        return 'BLOB'
      default:
        return 'TEXT'
    }
  }
