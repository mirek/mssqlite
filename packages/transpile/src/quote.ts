import type { Ast } from '@mssqlite/tsql'

/** @returns SQLite double-quoted identifier. */
export const identifier =
  (name: string): string =>
    `"${name.replaceAll('"', '""')}"`

/** @returns SQLite single-quoted string literal. */
export const string =
  (value: string): string =>
    `'${value.replaceAll('\'', '\'\'')}'`

/** @returns collision-free SQLite attachment alias for a SQL database name. */
export const databaseAlias =
  (name: string): string =>
    `mssqlite_${[ ...new TextEncoder().encode(name.toLowerCase()) ]
      .map(byte => byte.toString(16).padStart(2, '0')).join('')}`

const schemaObject =
  (schema_: string, object: string): string => {
    const schema = schema_.toLowerCase()
    if (schema === 'dbo' || schema === '') {
      return object
    }
    if (schema === 'sys' || schema === 'information_schema') {
      return `${schema}.${object.toLowerCase()}`
    }
    return `${schema_}.${object}`
  }

/** @returns SQLite PRAGMA table_info invocation for a possibly attached object. */
export const pragmaTableInfo =
  (name: Ast.QualifiedName): string => {
    if (name.length >= 3) {
      const database = name[name.length - 3] ?? ''
      const schema = name[name.length - 2] ?? 'dbo'
      const object = name[name.length - 1] ?? ''
      return `PRAGMA ${identifier(databaseAlias(database))}.table_info(${identifier(schemaObject(schema, object))})`
    }
    const object = name[name.length - 1] ?? ''
    return object.startsWith('#') ?
      `PRAGMA temp.table_info(${identifier(object)})` :
      `PRAGMA table_info(${identifier(schemaObject(name.length === 2 ? name[0] ?? '' : '', object))})`
  }

/**
 * @returns flat SQLite object name of a T-SQL qualified name. Database
 * qualifiers become attachment aliases and the default `dbo` schema drops; `sys` and
 * `INFORMATION_SCHEMA` objects keep their prefix as part of a flat,
 * lowercased name (`sys.tables` → `"sys.tables"`); other schemas flatten
 * into a dotted single identifier.
 */
export const objectName =
  (name: Ast.QualifiedName): string => {
    if (name.length >= 3) {
      const database = name[name.length - 3] ?? ''
      const schema = name[name.length - 2] ?? 'dbo'
      const object = name[name.length - 1] ?? ''
      return `${identifier(databaseAlias(database))}.${identifier(schemaObject(schema, object))}`
    }
    const parts = name.length > 2 ? name.slice(-2) : [ ...name ]
    if (parts.length === 2) {
      const schema = parts[0] ?? ''
      const table = parts[1] ?? ''
      return identifier(schemaObject(schema, table))
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
