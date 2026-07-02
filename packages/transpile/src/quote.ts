import type { Ast } from '@mssqlite/tsql'

/** @returns SQLite double-quoted identifier. */
export const identifier =
  (name: string): string =>
    `"${name.replaceAll('"', '""')}"`

/** @returns SQLite single-quoted string literal. */
export const string =
  (value: string): string =>
    `'${value.replaceAll('\'', '\'\'')}'`

/**
 * @returns flat SQLite object name of a T-SQL qualified name. Database
 * qualifiers and the default `dbo` schema are dropped; `sys` and
 * `INFORMATION_SCHEMA` objects keep their prefix as part of a flat,
 * lowercased name (`sys.tables` → `"sys.tables"`); other schemas flatten
 * into a dotted single identifier.
 */
export const objectName =
  (name: Ast.QualifiedName): string => {
    const parts = name.length > 2 ? name.slice(-2) : [ ...name ]
    if (parts.length === 2) {
      const schema = (parts[0] ?? '').toLowerCase()
      const table = parts[1] ?? ''
      if (schema === 'dbo' || schema === '') {
        return identifier(table)
      }
      if (schema === 'sys' || schema === 'information_schema') {
        return identifier(`${schema}.${table.toLowerCase()}`)
      }
      return identifier(`${parts[0]}.${table}`)
    }
    const single = parts[0] ?? ''
    // Temp tables (#name) live in SQLite's temp schema.
    return single.startsWith('#') ?
      `temp.${identifier(single)}` :
      identifier(single)
  }

/** @returns dotted column reference — all but the last part form the table qualifier. */
export const columnName =
  (name: Ast.QualifiedName): string => {
    if (name.length === 1) {
      return identifier(name[0] ?? '')
    }
    const column = name[name.length - 1] ?? ''
    const qualifier = name[name.length - 2] ?? ''
    return `${identifier(qualifier)}.${identifier(column)}`
  }
