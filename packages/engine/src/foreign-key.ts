import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { DatabaseSync } from 'node:sqlite'

type ForeignKey = {
  readonly index: number,
  readonly columns: readonly string[],
  readonly references: NonNullable<Ast.ColumnDefinition['references']>
}

type Pair = {
  readonly child: string,
  readonly parent: Catalog.ColumnRow
}

const physicalName =
  (name: Ast.QualifiedName): Ast.QualifiedName =>
    name.length >= 3 ? name.slice(-2) : name

const textType =
  (column: Ast.ColumnDefinition | undefined): boolean =>
    column !== undefined && [ 'text', 'ntext' ].includes(Transpile.Type.category(column.type) ?? '')

const foreignKeys =
  (statement: Ast.Statement & { kind: 'createTable' }): readonly ForeignKey[] => {
    const definitions = new Map(statement.columns.map(column => [ column.name.toLowerCase(), column ]))
    const columnKeys = statement.columns.flatMap((column, index) =>
      column.references !== undefined && textType(column) ? [ {
        index,
        columns: [ column.name ],
        references: column.references
      } ] : [])
    const constraintKeys = statement.constraints.flatMap((constraint, index) =>
      constraint.kind === 'foreignKey' &&
      constraint.columns.some(column => textType(definitions.get(column.toLowerCase()))) ? [ {
          index: statement.columns.length + index,
          columns: constraint.columns,
          references: constraint.references
        } ] : [])
    return [ ...columnKeys, ...constraintKeys ]
  }

const primaryColumns =
  (db: DatabaseSync, objectId: number): readonly Catalog.ColumnRow[] =>
    db.prepare(
      `SELECT c.* FROM "sys.indexes" i
        JOIN "sys.index_columns" ic
          ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN "sys.columns" c
          ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = ? AND i.is_primary_key = 1 AND ic.key_ordinal > 0
        ORDER BY ic.key_ordinal`
    ).all(objectId) as unknown as Catalog.ColumnRow[]

const pairsOf =
  (db: DatabaseSync, key: ForeignKey): readonly Pair[] => {
    const objectId = Catalog.objectIdOf(db, physicalName(key.references.table))
    if (objectId === undefined) {
      return []
    }
    const columns = Catalog.tableColumns(db, objectId)
    const byName = new Map(columns.map(column => [ column.name.toLowerCase(), column ]))
    const referenced = key.references.columns === undefined ? primaryColumns(db, objectId) :
      key.references.columns.flatMap(name => byName.get(name.toLowerCase()) ?? [])
    return key.columns.flatMap((child, index) => {
      const parent = referenced[index]
      return parent === undefined ? [] : [ { child, parent } ]
    })
  }

const value =
  (prefix: string, column: string): string =>
    `${prefix}.${Transpile.Quote.identifier(column)}`

const keyValue =
  (rendered: string, column: Catalog.ColumnRow): string =>
    column.collation_name === null ? rendered :
      Transpile.Collation.expressionKey(rendered, column.collation_name)

const match =
  (pairs: readonly Pair[], childPrefix: string, parentPrefix: string): string =>
    pairs.map(pair => `${keyValue(value(childPrefix, pair.child), pair.parent)} = ` +
      keyValue(value(parentPrefix, pair.parent.name), pair.parent)).join(' AND ')

const changed =
  (pairs: readonly Pair[]): string =>
    pairs.map(pair => `NOT (${keyValue(value('OLD', pair.parent.name), pair.parent)} IS ` +
      `${keyValue(value('NEW', pair.parent.name), pair.parent)})`).join(' OR ')

const nameKey =
  (table: Ast.QualifiedName): string =>
    physicalName(table).map(part => [ ...new TextEncoder().encode(part.toLowerCase()) ]
      .map(byte => byte.toString(16).padStart(2, '0')).join('')).join('_')

const triggerName =
  (table: Ast.QualifiedName, index: number, operation: string): string =>
    `__mssqlite_fk_${nameKey(table)}_${index}_${operation}`

const triggerPrefix =
  (table: Ast.QualifiedName): string =>
    `__mssqlite_fk_${nameKey(table)}_`

const createTrigger =
  (
    db: DatabaseSync,
    name: string,
    timing: 'BEFORE' | 'AFTER',
    operation: string,
    table: string,
    when: string,
    body: string
  ): void => {
    db.exec(
      `CREATE TRIGGER ${Transpile.Quote.identifier(name)} ${timing} ${operation} ON ${table} ` +
      `FOR EACH ROW WHEN ${when} BEGIN ${body}; END`
    )
  }

const childTriggers =
  (db: DatabaseSync, statement: Ast.Statement & { kind: 'createTable' }, key: ForeignKey, pairs: readonly Pair[]): void => {
    const child = Transpile.Quote.objectName(physicalName(statement.name))
    const parent = Transpile.Quote.objectName(physicalName(key.references.table))
    const present = pairs.map(pair => `${value('NEW', pair.child)} IS NOT NULL`).join(' AND ')
    const missing = `NOT EXISTS (SELECT 1 FROM ${parent} AS "__mssqlite_parent" WHERE ` +
      `${match(pairs, 'NEW', '"__mssqlite_parent"')})`
    const failure = 'SELECT RAISE(ABORT, \'FOREIGN KEY constraint failed\')'
    createTrigger(db, triggerName(statement.name, key.index, 'child_insert'), 'BEFORE', 'INSERT', child,
      `${present} AND ${missing}`, failure)
    const columns = key.columns.map(Transpile.Quote.identifier).join(', ')
    createTrigger(db, triggerName(statement.name, key.index, 'child_update'), 'BEFORE',
      `UPDATE OF ${columns}`, child, `${present} AND ${missing}`, failure)
  }

const defaultValues =
  (db: DatabaseSync, table: Ast.QualifiedName): ReadonlyMap<string, string> => {
    const rows = db.prepare(Transpile.Quote.pragmaTableInfo(physicalName(table))).all() as unknown as
      { readonly name: string, readonly dflt_value: string | null }[]
    return new Map(rows.map(row => [ row.name.toLowerCase(), row.dflt_value ?? 'NULL' ]))
  }

const actionBody =
  (
    action: Ast.ReferentialAction | undefined,
    event: 'delete' | 'update',
    child: string,
    pairs: readonly Pair[],
    defaults: ReadonlyMap<string, string>
  ): { readonly timing: 'BEFORE' | 'AFTER', readonly body: string } => {
    const where = match(pairs, '"__mssqlite_child"', 'OLD')
    if (action === 'cascade') {
      if (event === 'delete') {
        return { timing: 'AFTER', body: `DELETE FROM ${child} WHERE ${match(pairs, child, 'OLD')}` }
      }
      const set = pairs.map(pair => `${Transpile.Quote.identifier(pair.child)} = ` +
        value('NEW', pair.parent.name)).join(', ')
      return { timing: 'AFTER', body: `UPDATE ${child} SET ${set} WHERE ${match(pairs, child, 'OLD')}` }
    }
    if (action === 'setNull' || action === 'setDefault') {
      const set = pairs.map(pair => `${Transpile.Quote.identifier(pair.child)} = ` +
        (action === 'setNull' ? 'NULL' : defaults.get(pair.child.toLowerCase()) ?? 'NULL')).join(', ')
      return { timing: 'AFTER', body: `UPDATE ${child} SET ${set} WHERE ${match(pairs, child, 'OLD')}` }
    }
    return {
      timing: 'BEFORE',
      body: 'SELECT RAISE(ABORT, \'FOREIGN KEY constraint failed\') ' +
        `WHERE EXISTS (SELECT 1 FROM ${child} AS "__mssqlite_child" WHERE ${where})`
    }
  }

const parentTriggers =
  (db: DatabaseSync, statement: Ast.Statement & { kind: 'createTable' }, key: ForeignKey, pairs: readonly Pair[]): void => {
    const parent = Transpile.Quote.objectName(physicalName(key.references.table))
    const child = Transpile.Quote.objectName(physicalName(statement.name))
    const defaults = defaultValues(db, statement.name)
    const remove = actionBody(key.references.onDelete, 'delete', child, pairs, defaults)
    createTrigger(db, triggerName(statement.name, key.index, 'parent_delete'), remove.timing,
      'DELETE', parent, '1', remove.body)
    const update = actionBody(key.references.onUpdate, 'update', child, pairs, defaults)
    const columns = pairs.map(pair => Transpile.Quote.identifier(pair.parent.name)).join(', ')
    createTrigger(db, triggerName(statement.name, key.index, 'parent_update'), update.timing,
      `UPDATE OF ${columns}`, parent, changed(pairs), update.body)
  }

/** Installs collation-key foreign keys that SQLite's native comparator cannot express. */
export const installTextForeignKeys =
  (db: DatabaseSync, statement: Ast.Statement & { kind: 'createTable' }): void => {
    for (const foreignKey of foreignKeys(statement)) {
      const pairs = pairsOf(db, foreignKey)
      if (pairs.length !== foreignKey.columns.length) {
        continue
      }
      childTriggers(db, statement, foreignKey, pairs)
      parentTriggers(db, statement, foreignKey, pairs)
    }
  }

/** Removes outgoing logical-FK triggers and rejects tables still referenced by another table. */
export const prepareTextForeignKeyDrop =
  (db: DatabaseSync, tables: readonly Ast.QualifiedName[]): void => {
    const rows = (db.prepare(
      `SELECT name, tbl_name FROM sqlite_schema
        WHERE type = 'trigger' AND name LIKE '__mssqlite_fk_%'`
    ).all() as unknown as { readonly name: string, readonly tbl_name: string }[])
      .filter(row => row.name.startsWith('__mssqlite_fk_'))
    const prefixes = tables.map(triggerPrefix)
    const removed = new Set(rows.filter(row => prefixes.some(prefix => row.name.startsWith(prefix)))
      .map(row => row.name))
    const targets = new Set(tables.map(table => {
      const at = Catalog.objectNameOf(physicalName(table))
      return at.schema.toLowerCase() === 'dbo' ? at.name.toLowerCase() :
        `${at.schema}.${at.name}`.toLowerCase()
    }))
    if (rows.some(row => targets.has(row.tbl_name.toLowerCase()) && !removed.has(row.name) &&
      (row.name.endsWith('_parent_delete') || row.name.endsWith('_parent_update')))) {
      throw new MssqlError(
        'Could not drop object because it is referenced by a FOREIGN KEY constraint.', 3726, 16)
    }
    for (const name of removed) {
      db.exec(`DROP TRIGGER ${Transpile.Quote.identifier(name)}`)
    }
  }
