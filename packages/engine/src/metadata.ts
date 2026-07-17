import { objectIdOf, tableColumns, TypeRow, type ColumnRow } from '@mssqlite/catalog'
import { Collation, TypeInfo } from '@mssqlite/tds'
import type { ColumnHint } from '@mssqlite/transpile'
import type { TableVariable, Value } from './session.ts'
import type { DatabaseSync, StatementSync } from 'node:sqlite'

/** Result set column with TDS metadata. */
export type Column = {
  readonly name: string,
  readonly typeInfo: TypeInfo.t,
  readonly nullable: boolean,
  readonly userType?: number
}

export type t =
  Column

/** @returns TDS TYPE_INFO of a sys.columns catalog row. */
export const typeInfoOfCatalogRow =
  (row: ColumnRow): TypeInfo.t => {
    switch (row.system_type_id) {
      case 48:
        return TypeInfo.intN(1)
      case 52:
        return TypeInfo.intN(2)
      case 56:
        return TypeInfo.intN(4)
      case 127:
        return TypeInfo.intN(8)
      case 104:
        return TypeInfo.bitN()
      case 59:
        return TypeInfo.floatN(4)
      case 62:
        return TypeInfo.floatN(8)
      case 106:
      case 108:
        return TypeInfo.decimalN(row.precision, row.scale)
      case 60:
      case 122:
        return TypeInfo.moneyN(row.system_type_id === 60 ? 8 : 4)
      case 58:
        return TypeInfo.datetimeN(4)
      case 61:
        return TypeInfo.datetimeN(8)
      case 40:
        return TypeInfo.dateN()
      case 41:
        return TypeInfo.timeN(row.scale)
      case 42:
        return TypeInfo.datetime2N(row.scale)
      case 43:
        return TypeInfo.datetimeOffsetN(row.scale)
      case 36:
        return TypeInfo.guid()
      case 98:
        return TypeInfo.sqlVariant()
      case 167:
      case 35:
        return TypeInfo.varchar(
          row.max_length === -1 || row.max_length === 16 ? 'max' : row.max_length,
          Collation.ofName(row.collation_name))
      case 175:
        return TypeInfo.char(row.max_length, Collation.ofName(row.collation_name))
      case 231:
      case 99:
        return TypeInfo.nvarchar(
          row.max_length === -1 || row.max_length === 16 ? 'max' : row.max_length / 2,
          Collation.ofName(row.collation_name))
      case 239:
        return TypeInfo.nchar(row.max_length / 2, Collation.ofName(row.collation_name))
      case 165:
      case 173:
      case 34:
        return TypeInfo.varbinary(row.max_length === -1 || row.max_length === 16 ? 'max' : row.max_length)
      case 189:
        return row.is_nullable === 0 ? TypeInfo.binary(8) : TypeInfo.varbinary(8)
      case 240: {
        const type = TypeRow.rows.find(candidate => candidate.userTypeId === row.user_type_id)
        return type?.assemblyQualifiedName === undefined ? TypeInfo.varbinary('max') :
          TypeInfo.udt(type.name, type.assemblyQualifiedName,
            type.maxLength < 0 ? 0xffff : type.maxLength)
      }
      case 241:
        return TypeInfo.xml()
      default:
        return TypeInfo.nvarchar('max')
    }
  }

/** @returns TDS TYPE_INFO inferred from the values of one result column. */
export const typeInfoOfValues =
  (values: readonly Value[]): TypeInfo.t => {
    let big = false
    let real = false
    let blob = false
    let any = false
    for (const value of values) {
      if (value === null) {
        continue
      }
      any = true
      if (typeof value === 'number') {
        if (Number.isInteger(value)) {
          if (value > 2147483647 || value < -2147483648) {
            big = true
          }
        } else {
          real = true
        }
      } else if (typeof value === 'bigint') {
        big = true
      } else if (value instanceof Uint8Array) {
        blob = true
      } else {
        return TypeInfo.nvarchar('max')
      }
    }
    if (!any) {
      return TypeInfo.intN(4)
    }
    if (blob) {
      return TypeInfo.varbinary('max')
    }
    if (real) {
      return TypeInfo.floatN(8)
    }
    return TypeInfo.intN(big ? 8 : 4)
  }

/** Column descriptor from `StatementSync.columns()`. */
type SourceColumn = {
  readonly name: string,
  readonly column: string | null,
  readonly table: string | null,
  readonly type: string | null
}

const catalogColumn =
  (db: DatabaseSync, table: string, column: string): ColumnRow | undefined => {
    const objectId = objectIdOf(db, table.split('.'))
    if (objectId === undefined) {
      return undefined
    }
    return tableColumns(db, objectId)
      .find(row => row.name.toLowerCase() === column.toLowerCase())
  }

const tableVariableColumn =
  (tables: Iterable<TableVariable>, table: string, column: string): Column | undefined => {
    for (const variable of tables) {
      const backing = variable.table[variable.table.length - 1] ?? ''
      if (backing.toLowerCase() !== table.toLowerCase()) {
        continue
      }
      const definition = variable.columns.find(candidate =>
        candidate.name.toLowerCase() === column.toLowerCase())
      if (definition === undefined) {
        return undefined
      }
      const type = TypeRow.columnType(definition.type)
      if (type === undefined) {
        return undefined
      }
      const tablePrimaryKey = variable.constraints.some(constraint =>
        constraint.kind === 'primaryKey' && constraint.columns.some(candidate =>
          candidate.name.toLowerCase() === column.toLowerCase()))
      const row: ColumnRow = {
        object_id: 0,
        name: definition.name,
        column_id: 0,
        system_type_id: type.systemTypeId,
        user_type_id: type.userTypeId,
        max_length: type.maxLength,
        precision: type.precision,
        scale: type.scale,
        collation_name: definition.collate ?? type.collationName,
        is_nullable: definition.nullable === false || definition.primaryKey === true || tablePrimaryKey ||
          ([ 'rowversion', 'timestamp' ].includes(definition.type.name) && definition.nullable !== true) ? 0 : 1,
        is_identity: definition.identity === undefined ? 0 : 1,
        is_computed: definition.computed === undefined ? 0 : 1
      }
      return {
        name: definition.name,
        typeInfo: typeInfoOfCatalogRow(row),
        nullable: row.is_nullable !== 0,
        userType: row.user_type_id
      }
    }
    return undefined
  }

const hintedColumn =
  (hint: ColumnHint): Column | undefined => {
    const type = TypeRow.columnType(hint.type)
    if (type === undefined) {
      return undefined
    }
    const row: ColumnRow = {
      object_id: 0,
      name: hint.name,
      column_id: 0,
      system_type_id: type.systemTypeId,
      user_type_id: type.userTypeId,
      max_length: type.maxLength,
      precision: type.precision,
      scale: type.scale,
      collation_name: hint.collation ?? type.collationName,
      is_nullable: hint.nullable ? 1 : 0,
      is_identity: 0,
      is_computed: 0
    }
    return {
      name: hint.name,
      typeInfo: typeInfoOfCatalogRow(row),
      nullable: hint.nullable,
      userType: row.user_type_id
    }
  }

/**
 * @returns TDS column metadata for a prepared statement's result — catalog
 * lookups when the column maps to a table column, value shape otherwise.
 */
export const columnsOf =
  (
    db: DatabaseSync,
    statement: StatementSync,
    rows: readonly (readonly Value[])[],
    tableVariables: Iterable<TableVariable> = [],
    hints: readonly ColumnHint[] = []
  ): Column[] => {
    const sources = statement.columns() as unknown as SourceColumn[]
    const variables = [ ...tableVariables ]
    return sources.map((source, index) => {
      const hinted = hints[index] === undefined ? undefined : hintedColumn(hints[index])
      if (hinted !== undefined) {
        return { ...hinted, name: source.name }
      }
      if (source.table !== null && source.column !== null) {
        const row = catalogColumn(db, source.table, source.column)
        if (row !== undefined) {
          return {
            name: source.name,
            typeInfo: typeInfoOfCatalogRow(row),
            nullable: row.is_nullable !== 0,
            userType: row.user_type_id
          }
        }
        const variable = tableVariableColumn(variables, source.table, source.column)
        if (variable !== undefined) {
          return { ...variable, name: source.name }
        }
      }
      const values = rows.map(row => row[index] ?? null)
      return {
        name: source.name,
        typeInfo: typeInfoOfValues(values),
        nullable: true
      }
    })
  }
