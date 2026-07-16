import type { TypeName } from '@mssqlite/tsql'

/** sys.types row shape shared by seeds and column mapping. */
export type TypeRow = {
  readonly userTypeId: number,
  readonly name: string,
  readonly systemTypeId: number,
  readonly maxLength: number,
  readonly precision: number,
  readonly scale: number,
  readonly collationName: string | null,
  readonly schemaId?: number,
  readonly isAssemblyType?: boolean,
  readonly assemblyQualifiedName?: string
}

export type t =
  TypeRow

const collation = 'SQL_Latin1_General_CP1_CI_AS'

/** All built-in system types, per sys.types. */
export const rows: readonly TypeRow[] = [
  { userTypeId: 34, name: 'image', systemTypeId: 34, maxLength: 16, precision: 0, scale: 0, collationName: null },
  { userTypeId: 35, name: 'text', systemTypeId: 35, maxLength: 16, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 36, name: 'uniqueidentifier', systemTypeId: 36, maxLength: 16, precision: 0, scale: 0, collationName: null },
  { userTypeId: 40, name: 'date', systemTypeId: 40, maxLength: 3, precision: 10, scale: 0, collationName: null },
  { userTypeId: 41, name: 'time', systemTypeId: 41, maxLength: 5, precision: 16, scale: 7, collationName: null },
  { userTypeId: 42, name: 'datetime2', systemTypeId: 42, maxLength: 8, precision: 27, scale: 7, collationName: null },
  { userTypeId: 43, name: 'datetimeoffset', systemTypeId: 43, maxLength: 10, precision: 34, scale: 7, collationName: null },
  { userTypeId: 48, name: 'tinyint', systemTypeId: 48, maxLength: 1, precision: 3, scale: 0, collationName: null },
  { userTypeId: 52, name: 'smallint', systemTypeId: 52, maxLength: 2, precision: 5, scale: 0, collationName: null },
  { userTypeId: 56, name: 'int', systemTypeId: 56, maxLength: 4, precision: 10, scale: 0, collationName: null },
  { userTypeId: 58, name: 'smalldatetime', systemTypeId: 58, maxLength: 4, precision: 16, scale: 0, collationName: null },
  { userTypeId: 59, name: 'real', systemTypeId: 59, maxLength: 4, precision: 24, scale: 0, collationName: null },
  { userTypeId: 60, name: 'money', systemTypeId: 60, maxLength: 8, precision: 19, scale: 4, collationName: null },
  { userTypeId: 61, name: 'datetime', systemTypeId: 61, maxLength: 8, precision: 23, scale: 3, collationName: null },
  { userTypeId: 62, name: 'float', systemTypeId: 62, maxLength: 8, precision: 53, scale: 0, collationName: null },
  { userTypeId: 98, name: 'sql_variant', systemTypeId: 98, maxLength: 8016, precision: 0, scale: 0, collationName: null },
  { userTypeId: 99, name: 'ntext', systemTypeId: 99, maxLength: 16, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 104, name: 'bit', systemTypeId: 104, maxLength: 1, precision: 1, scale: 0, collationName: null },
  { userTypeId: 106, name: 'decimal', systemTypeId: 106, maxLength: 17, precision: 38, scale: 38, collationName: null },
  { userTypeId: 108, name: 'numeric', systemTypeId: 108, maxLength: 17, precision: 38, scale: 38, collationName: null },
  { userTypeId: 122, name: 'smallmoney', systemTypeId: 122, maxLength: 4, precision: 10, scale: 4, collationName: null },
  { userTypeId: 127, name: 'bigint', systemTypeId: 127, maxLength: 8, precision: 19, scale: 0, collationName: null },
  {
    userTypeId: 128, name: 'hierarchyid', systemTypeId: 240, maxLength: 892,
    precision: 0, scale: 0, collationName: null, schemaId: 4, isAssemblyType: true,
    assemblyQualifiedName: 'Microsoft.SqlServer.Types.SqlHierarchyId, Microsoft.SqlServer.Types, Version=10.0.0.0, Culture=neutral, PublicKeyToken=89845dcd8080cc91'
  },
  {
    userTypeId: 129, name: 'geometry', systemTypeId: 240, maxLength: -1,
    precision: 0, scale: 0, collationName: null, schemaId: 4, isAssemblyType: true,
    assemblyQualifiedName: 'Microsoft.SqlServer.Types.SqlGeometry, Microsoft.SqlServer.Types, Version=10.0.0.0, Culture=neutral, PublicKeyToken=89845dcd8080cc91'
  },
  {
    userTypeId: 130, name: 'geography', systemTypeId: 240, maxLength: -1,
    precision: 0, scale: 0, collationName: null, schemaId: 4, isAssemblyType: true,
    assemblyQualifiedName: 'Microsoft.SqlServer.Types.SqlGeography, Microsoft.SqlServer.Types, Version=10.0.0.0, Culture=neutral, PublicKeyToken=89845dcd8080cc91'
  },
  { userTypeId: 165, name: 'varbinary', systemTypeId: 165, maxLength: 8000, precision: 0, scale: 0, collationName: null },
  { userTypeId: 167, name: 'varchar', systemTypeId: 167, maxLength: 8000, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 173, name: 'binary', systemTypeId: 173, maxLength: 8000, precision: 0, scale: 0, collationName: null },
  { userTypeId: 175, name: 'char', systemTypeId: 175, maxLength: 8000, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 189, name: 'timestamp', systemTypeId: 189, maxLength: 8, precision: 0, scale: 0, collationName: null },
  { userTypeId: 231, name: 'nvarchar', systemTypeId: 231, maxLength: 8000, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 239, name: 'nchar', systemTypeId: 239, maxLength: 8000, precision: 0, scale: 0, collationName: collation },
  { userTypeId: 241, name: 'xml', systemTypeId: 241, maxLength: -1, precision: 0, scale: 0, collationName: null },
  { userTypeId: 256, name: 'sysname', systemTypeId: 231, maxLength: 256, precision: 0, scale: 0, collationName: collation }
] as const

const byName = new Map(rows.map(row => [ row.name, row ]))

const synonyms: Record<string, string> = {
  integer: 'int',
  dec: 'decimal',
  'double precision': 'float',
  'character varying': 'varchar',
  character: 'char',
  'national character varying': 'nvarchar',
  'national char varying': 'nvarchar',
  'national character': 'nchar',
  'national char': 'nchar',
  'national text': 'ntext',
  rowversion: 'timestamp'
} as const

/** Column metadata derived from a declared T-SQL type. */
export type ColumnType = {
  readonly systemTypeId: number,
  readonly userTypeId: number,
  readonly maxLength: number,
  readonly precision: number,
  readonly scale: number,
  readonly collationName: string | null
}

const decimalLength =
  (precision: number): number =>
    precision <= 9 ?
      5 :
      precision <= 19 ?
        9 :
        precision <= 28 ?
          13 :
          17

const timeLength =
  (scale: number): number =>
    scale <= 2 ?
      3 :
      scale <= 4 ?
        4 :
        5

/** @returns sys.columns type fields of a declared T-SQL type, `undefined` for unknown types. */
export const columnType =
  (type: TypeName.t): ColumnType | undefined => {
    const name = synonyms[type.name] ?? type.name
    const row = byName.get(name)
    if (row === undefined) {
      return undefined
    }
    const first = type.args[0]
    const length = first === 'max' ? -1 : first
    const base = {
      systemTypeId: row.systemTypeId,
      userTypeId: row.userTypeId,
      collationName: row.collationName
    }
    switch (name) {
      case 'decimal':
      case 'numeric': {
        const precision = typeof length === 'number' ? length : 18
        const scale = typeof type.args[1] === 'number' ? type.args[1] : 0
        return { ...base, maxLength: decimalLength(precision), precision, scale }
      }
      case 'time': {
        const scale = typeof length === 'number' ? length : 7
        return { ...base, maxLength: timeLength(scale), precision: 9 + scale, scale }
      }
      case 'datetime2': {
        const scale = typeof length === 'number' ? length : 7
        return { ...base, maxLength: timeLength(scale) + 3, precision: 20 + scale, scale }
      }
      case 'datetimeoffset': {
        const scale = typeof length === 'number' ? length : 7
        return { ...base, maxLength: timeLength(scale) + 5, precision: 27 + scale, scale }
      }
      case 'char':
      case 'varchar':
      case 'binary':
      case 'varbinary':
        return { ...base, maxLength: length ?? 1, precision: 0, scale: 0 }
      case 'nchar':
      case 'nvarchar':
        return { ...base, maxLength: length === undefined ? 2 : length === -1 ? -1 : length * 2, precision: 0, scale: 0 }
      case 'sysname':
        return { ...base, maxLength: 256, precision: 0, scale: 0 }
      default:
        return { ...base, maxLength: row.maxLength, precision: row.precision, scale: row.scale }
    }
  }
