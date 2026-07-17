import { objectIdOf, objectNameOf } from './maintain.ts'
import type { DatabaseSync } from 'node:sqlite'

export type RenameKind =
  | 'object'
  | 'column'
  | 'index'

export type RenameResult = {
  readonly kind: RenameKind,
  readonly objectType: string,
  readonly oldName: readonly string[],
  readonly newName: readonly string[]
}

const identifier =
  (name: string): string =>
    `"${name.replaceAll('"', '""')}"`

const unquote =
  (part: string): string => {
    const trimmed = part.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1).replaceAll(']]', ']')
    }
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replaceAll('""', '"')
    }
    return trimmed
  }

/** Splits a SQL Server multipart identifier while preserving dots in brackets. */
export const nameParts =
  (name: string): string[] =>
    (name.match(/\[(?:[^\]]|\]\])*\]|"(?:[^"]|"")*"|[^.]+/g) ?? [])
      .map(unquote)
      .filter(part => part !== '')

const physicalName =
  (schema: string, name: string): string =>
    schema.toLowerCase() === 'dbo' ? name : `${schema}.${name}`

type ObjectRow = {
  readonly object_id: number,
  readonly name: string,
  readonly schema_name: string,
  readonly type: string
}

const objectRow =
  (db: DatabaseSync, name: readonly string[]): ObjectRow | undefined => {
    const at = objectNameOf(name)
    return db.prepare(
      `SELECT o.object_id, o.name, s.name AS schema_name, o.type
        FROM "sys.objects" o
        JOIN "sys.schemas" s ON s.schema_id = o.schema_id
        WHERE o.name = ? AND s.name = ?`
    ).get(at.name, at.schema) as ObjectRow | undefined
  }

const renamePhysicalObject =
  (db: DatabaseSync, object: ObjectRow, newName: string): void => {
    const oldPhysical = physicalName(object.schema_name, object.name)
    const newPhysical = physicalName(object.schema_name, newName)
    if (object.type === 'U') {
      db.exec(`ALTER TABLE ${identifier(oldPhysical)} RENAME TO ${identifier(newPhysical)}`)
      return
    }
    if (object.type === 'V') {
      const row = db.prepare(
        'SELECT sql FROM sqlite_schema WHERE type = \'view\' AND name = ?'
      ).get(oldPhysical) as { sql: string | null } | undefined
      const sql = row?.sql ?? ''
      const at = /\sAS\s/i.exec(sql)?.index
      if (at === undefined) {
        throw new Error(`View '${object.name}' cannot be renamed.`)
      }
      const select = sql.slice(at)
      db.exec(`DROP VIEW ${identifier(oldPhysical)}`)
      db.exec(`CREATE VIEW ${identifier(newPhysical)}${select}`)
    }
  }

const renameObject =
  (db: DatabaseSync, parts: readonly string[], newName: string): RenameResult => {
    const object = objectRow(db, parts)
    if (object === undefined) {
      throw new Error(`Object '${parts.join('.')}' does not exist.`)
    }
    const conflict = objectIdOf(db, [ object.schema_name, newName ])
    if (conflict !== undefined) {
      throw new Error(`The name '${newName}' is already in use.`)
    }
    renamePhysicalObject(db, object, newName)
    db.prepare(
      `UPDATE "sys.objects"
        SET name = ?, modify_date = strftime('%Y-%m-%d %H:%M:%S', 'now')
        WHERE object_id = ?`
    ).run(newName, object.object_id)
    return {
      kind: 'object',
      objectType: object.type,
      oldName: [ object.schema_name, object.name ],
      newName: [ object.schema_name, newName ]
    }
  }

const renameColumn =
  (db: DatabaseSync, parts: readonly string[], newName: string): RenameResult => {
    const column = parts[parts.length - 1] ?? ''
    const tableParts = parts.slice(0, -1)
    const object = objectRow(db, tableParts)
    if (object === undefined || object.type !== 'U') {
      throw new Error(`Table '${tableParts.join('.')}' does not exist.`)
    }
    const existing = db.prepare(
      'SELECT column_id FROM "sys.columns" WHERE object_id = ? AND name = ?'
    ).get(object.object_id, column) as { column_id: number } | undefined
    if (existing === undefined) {
      throw new Error(`Column '${column}' does not exist.`)
    }
    const conflict = db.prepare(
      'SELECT 1 FROM "sys.columns" WHERE object_id = ? AND name = ?'
    ).get(object.object_id, newName)
    if (conflict !== undefined) {
      throw new Error(`The name '${newName}' is already in use.`)
    }
    const physical = physicalName(object.schema_name, object.name)
    db.exec(
      `ALTER TABLE ${identifier(physical)} RENAME COLUMN ${identifier(column)} TO ${identifier(newName)}`
    )
    db.prepare(
      'UPDATE "sys.columns" SET name = ? WHERE object_id = ? AND column_id = ?'
    ).run(newName, object.object_id, existing.column_id)
    db.prepare(
      `UPDATE "sys.objects" SET modify_date = strftime('%Y-%m-%d %H:%M:%S', 'now')
        WHERE object_id = ?`
    ).run(object.object_id)
    return {
      kind: 'column',
      objectType: object.type,
      oldName: [ object.schema_name, object.name, column ],
      newName: [ object.schema_name, object.name, newName ]
    }
  }

const renameIndex =
  (db: DatabaseSync, parts: readonly string[], newName: string): RenameResult => {
    const indexName = parts[parts.length - 1] ?? ''
    const tableParts = parts.slice(0, -1)
    const object = objectRow(db, tableParts)
    if (object === undefined || object.type !== 'U') {
      throw new Error(`Table '${tableParts.join('.')}' does not exist.`)
    }
    const index = db.prepare(
      'SELECT index_id FROM "sys.indexes" WHERE object_id = ? AND name = ?'
    ).get(object.object_id, indexName) as { index_id: number } | undefined
    if (index === undefined) {
      throw new Error(`Index '${indexName}' does not exist.`)
    }
    if (db.prepare('SELECT 1 FROM "sys.indexes" WHERE name = ?').get(newName) !== undefined) {
      throw new Error(`The name '${newName}' is already in use.`)
    }
    const schema = db.prepare(
      'SELECT sql FROM sqlite_schema WHERE type = \'index\' AND name = ?'
    ).get(indexName) as { sql: string | null } | undefined
    const sql = schema?.sql ?? ''
    const on = /\sON\s/i.exec(sql)?.index
    if (on === undefined) {
      throw new Error(`Index '${indexName}' cannot be renamed.`)
    }
    const unique = /^CREATE\s+UNIQUE\s+INDEX/i.test(sql) ? 'UNIQUE ' : ''
    db.exec(`CREATE ${unique}INDEX ${identifier(newName)}${sql.slice(on)}`)
    db.exec(`DROP INDEX ${identifier(indexName)}`)
    db.prepare(
      'UPDATE "sys.indexes" SET name = ? WHERE object_id = ? AND index_id = ?'
    ).run(newName, object.object_id, index.index_id)
    return {
      kind: 'index',
      objectType: object.type,
      oldName: [ object.schema_name, object.name, indexName ],
      newName: [ object.schema_name, object.name, newName ]
    }
  }

/** Atomically renames a SQLite object and its sys catalog identity. */
export const rename =
  (db: DatabaseSync, oldName: string, requestedName: string, kind: RenameKind): RenameResult => {
    const parts = nameParts(oldName)
    const newName = requestedName.slice(0, 128)
    if (parts.length === 0 || newName === '' || newName.includes('.')) {
      throw new Error('The supplied object or new name is invalid.')
    }
    db.exec('SAVEPOINT "mssqlite_sp_rename"')
    try {
      const result = kind === 'column' ? renameColumn(db, parts, newName) :
        kind === 'index' ? renameIndex(db, parts, newName) :
          renameObject(db, parts, newName)
      db.exec('RELEASE SAVEPOINT "mssqlite_sp_rename"')
      return result
    } catch (error) {
      db.exec('ROLLBACK TO SAVEPOINT "mssqlite_sp_rename"')
      db.exec('RELEASE SAVEPOINT "mssqlite_sp_rename"')
      throw error
    }
  }
