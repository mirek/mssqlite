import { randomUUID } from 'node:crypto'
import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import * as Identity from './identity.ts'
import * as Storage from './storage.ts'
import { MssqlError } from './error.ts'
import { typeNameOfCatalogRow } from './table-variable.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { Session } from './session.ts'
import type { DatabaseSync } from 'node:sqlite'

type Action = Extract<
  (Ast.Statement & { kind: 'alterTable' })['action'],
  { kind: 'alterColumn' }
>

type SchemaObject = {
  readonly type: 'index' | 'trigger' | 'view',
  readonly name: string,
  readonly tbl_name: string,
  readonly sql: string
}

const defaultCollation =
  'SQL_Latin1_General_CP1_CI_AS'

const physicalName =
  (name: Ast.QualifiedName): string => {
    const at = Catalog.objectNameOf(name.length >= 3 ? name.slice(-2) : name)
    return at.schema.toLowerCase() === 'dbo' ? at.name :
      `${at.schema}.${at.name}`
  }

const dependencyError =
  (column: string): MssqlError =>
    new MssqlError(
      `ALTER TABLE ALTER COLUMN ${column} failed because one or more objects access this column.`,
      4922, 16)

const declaredEqual =
  (left: TypeName.t, right: TypeName.t): boolean =>
    left.name === right.name && JSON.stringify(left.args) === JSON.stringify(right.args)

const lengthOf =
  (type: TypeName.t): number =>
    type.args[0] === 'max' ? Number.POSITIVE_INFINITY :
      typeof type.args[0] === 'number' ? type.args[0] : 1

const indexedWidening =
  (before: TypeName.t, after: TypeName.t, collationChanged: boolean): boolean =>
    !collationChanged && before.name === after.name &&
    [ 'varchar', 'nvarchar', 'varbinary' ].includes(before.name) &&
    lengthOf(after) >= lengthOf(before)

const referencesIdentifier =
  (definition: string | null, column: string): boolean => {
    if (definition === null) {
      return false
    }
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:\\[${escaped}\\]|"${escaped}"|\\b${escaped}\\b)`, 'iu').test(definition)
  }

const validateIdentity =
  (db: DatabaseSync, row: Catalog.ColumnRow, action: Action): void => {
    if (row.is_identity === 0) {
      return
    }
    const identity = Catalog.identityRows(db).find(candidate =>
      candidate.object_id === row.object_id && candidate.column_id === row.column_id)
    if (identity === undefined) {
      return
    }
    Identity.validateColumns([ {
      name: action.column,
      type: action.type,
      identity: { seed: identity.seed_value, increment: identity.increment_value }
    } ])
  }

const indexesOf =
  (db: DatabaseSync, row: Catalog.ColumnRow): readonly { readonly is_primary_key: number }[] =>
    db.prepare(
      `SELECT i.is_primary_key FROM "sys.index_columns" ic
        JOIN "sys.indexes" i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE ic.object_id = ? AND ic.column_id = ?`
    ).all(row.object_id, row.column_id) as unknown as { readonly is_primary_key: number }[]

const foreignKeyDependsOn =
  (db: DatabaseSync, row: Catalog.ColumnRow): boolean =>
    db.prepare(
      `SELECT 1 AS found FROM "sys.foreign_key_columns"
        WHERE (parent_object_id = ? AND parent_column_id = ?)
           OR (referenced_object_id = ? AND referenced_column_id = ?)
        LIMIT 1`
    ).get(row.object_id, row.column_id, row.object_id, row.column_id) !== undefined

const checkDependsOn =
  (db: DatabaseSync, row: Catalog.ColumnRow, column: string): boolean => {
    const checks = db.prepare(
      `SELECT definition, parent_column_id FROM "sys.check_constraints"
        WHERE object_id IN (
          SELECT object_id FROM "sys.objects" WHERE parent_object_id = ?
        )`
    ).all(row.object_id) as unknown as
      { readonly definition: string | null, readonly parent_column_id: number }[]
    return checks.some(check => check.parent_column_id === row.column_id ||
      referencesIdentifier(check.definition, column))
  }

const computedDependsOn =
  (db: DatabaseSync, row: Catalog.ColumnRow, column: string): boolean => {
    const computed = db.prepare(
      'SELECT definition FROM "sys.computed_columns_extra" WHERE object_id = ?'
    ).all(row.object_id) as unknown as { readonly definition: string | null }[]
    return computed.some(item => referencesIdentifier(item.definition, column))
  }

const rejectDependency =
  (dependent: boolean, column: string): void => {
    if (dependent) {
      throw dependencyError(column)
    }
  }

const validateIndexes =
  (
    db: DatabaseSync,
    row: Catalog.ColumnRow,
    before: TypeName.t,
    action: Action,
    structural: boolean,
    collationChanged: boolean
  ): void => {
    const indexes = indexesOf(db, row)
    rejectDependency(
      action.nullable && indexes.some(index => index.is_primary_key !== 0), action.column)
    rejectDependency(
      structural && indexes.length > 0 &&
        !indexedWidening(before, action.type, collationChanged),
      action.column)
  }

const validateDependencies =
  (
    db: DatabaseSync,
    row: Catalog.ColumnRow,
    before: TypeName.t,
    action: Action,
    collation: string | undefined
  ): void => {
    const typeChanged = !declaredEqual(before, action.type)
    const collationChanged = (row.collation_name ?? undefined) !== collation
    const structural = typeChanged || collationChanged
    rejectDependency([ row.is_computed !== 0, (row.is_rowguidcol ?? 0) !== 0,
      row.system_type_id === 189, action.type.name === 'timestamp',
      action.type.name === 'rowversion' ].some(Boolean), action.column)
    validateIdentity(db, row, action)
    validateIndexes(db, row, before, action, structural, collationChanged)
    rejectDependency(structural && foreignKeyDependsOn(db, row), action.column)
    const variableLength = before.name === action.type.name &&
      [ 'varchar', 'nvarchar', 'varbinary' ].includes(before.name) && !collationChanged
    rejectDependency(
      structural && checkDependsOn(db, row, action.column) && !variableLength, action.column)
    const defaultChanged = before.name !== action.type.name || collationChanged
    rejectDependency(
      structural && (row.default_object_id ?? 0) !== 0 && defaultChanged, action.column)
    rejectDependency(computedDependsOn(db, row, action.column), action.column)
  }

const quoteEnd =
  (value: string): number | undefined => {
    if (!value.startsWith('"')) {
      return undefined
    }
    for (let index = 1; index < value.length; index++) {
      if (value[index] !== '"') {
        continue
      }
      if (value[index + 1] === '"') {
        index++
        continue
      }
      return index + 1
    }
    return undefined
  }

const memberName =
  (member: string): string | undefined => {
    const end = quoteEnd(member)
    return end === undefined ? undefined : member.slice(1, end - 1).replaceAll('""', '"')
  }

type QuoteState = {
  readonly quote: '"' | '\'' | ']' | undefined,
  readonly skip: boolean
}

const openedQuote =
  (character: string | undefined): QuoteState['quote'] =>
    character === '[' ? ']' : character === '"' || character === '\'' ? character : undefined

const advanceQuote =
  (value: string, index: number, quote: Exclude<QuoteState['quote'], undefined>): QuoteState => {
    if (value[index] !== quote) {
      return { quote, skip: false }
    }
    return value[index + 1] === quote ? { quote, skip: true } :
      { quote: undefined, skip: false }
  }

const topLevelPositions =
  (value: string): readonly number[] => {
    const positions: number[] = []
    let depth = 0
    let quote: '"' | '\'' | ']' | undefined
    for (let index = 0; index < value.length; index++) {
      const character = value[index]
      if (quote !== undefined) {
        const advanced = advanceQuote(value, index, quote)
        quote = advanced.quote
        if (advanced.skip) {
          index++
        }
        continue
      }
      const opened = openedQuote(character)
      if (opened !== undefined) {
        quote = opened
      } else if (character === '(') {
        depth++
      } else if (character === ')') {
        depth--
      } else if (depth === 0) {
        positions.push(index)
      }
    }
    return positions
  }

const splitMembers =
  (definition: string): readonly string[] => {
    const open = definition.indexOf('(')
    const close = definition.lastIndexOf(')')
    if (open < 0 || close <= open) {
      return []
    }
    const body = definition.slice(open + 1, close)
    const members: string[] = []
    let start = 0
    for (const index of topLevelPositions(body).filter(at => body[at] === ',')) {
      members.push(body.slice(start, index).trim())
      start = index + 1
    }
    members.push(body.slice(start).trim())
    return members
  }

const withoutNotNull =
  (value: string): string => {
    for (const index of topLevelPositions(value)) {
      if (value.slice(index).match(/^\s+NOT\s+NULL(?=\s|$)/iu) !== null) {
        return `${value.slice(0, index)} ${value.slice(index).replace(/^\s+NOT\s+NULL/iu, '')}`
      }
    }
    return value
  }

const alteredMembers =
  (definition: string, action: Action, collation: string | undefined): readonly string[] => {
    const members = splitMembers(definition)
    const target = action.column.toLowerCase()
    const physical = Transpile.Type.columnType(action.type, collation)
    if (physical === '') {
      throw new MssqlError(`Column '${action.column}' has an invalid data type.`, 2715, 16)
    }
    let found = false
    const altered = members.map(member => {
      if (memberName(member)?.toLowerCase() !== target) {
        return member
      }
      found = true
      const end = quoteEnd(member) ?? 0
      const name = member.slice(0, end)
      let suffix = member.slice(end).trimStart()
      for (const prefix of [
        'TEXT COLLATE NOCASE', 'TEXT COLLATE BINARY', 'INTEGER', 'REAL', 'TEXT', 'BLOB'
      ]) {
        if (suffix.toUpperCase() === prefix || suffix.toUpperCase().startsWith(`${prefix} `)) {
          suffix = suffix.slice(prefix.length)
          break
        }
      }
      suffix = withoutNotNull(suffix)
      return `${name} ${physical}${action.nullable ? '' : ' NOT NULL'}${suffix}`
    })
    if (!found) {
      throw new MssqlError(`ALTER TABLE ALTER COLUMN failed because column '${action.column}' does not exist.`, 4924, 16)
    }
    return altered
  }

const schemaObjects =
  (db: DatabaseSync, table: string): readonly SchemaObject[] => {
    const quoted = Transpile.Quote.identifier(table).toLowerCase()
    return (db.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
        WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL`
    ).all() as unknown as SchemaObject[]).filter(object =>
      object.tbl_name.toLowerCase() === table.toLowerCase() ||
      object.sql.toLowerCase().includes(quoted))
  }

const dropSchemaObjects =
  (db: DatabaseSync, objects: readonly SchemaObject[]): void => {
    const order: Readonly<Record<SchemaObject['type'], number>> = { trigger: 0, view: 1, index: 2 }
    for (const object of [ ...objects ].sort((left, right) => order[left.type] - order[right.type])) {
      db.exec(`DROP ${object.type.toUpperCase()} ${Transpile.Quote.identifier(object.name)}`)
    }
  }

const recreateSchemaObjects =
  (db: DatabaseSync, objects: readonly SchemaObject[]): void => {
    const order: Readonly<Record<SchemaObject['type'], number>> = { index: 0, view: 1, trigger: 2 }
    for (const object of [ ...objects ].sort((left, right) => order[left.type] - order[right.type])) {
      db.exec(object.sql)
    }
  }

const ordinaryColumns =
  (db: DatabaseSync, table: string): readonly string[] =>
    (db.prepare(`PRAGMA table_xinfo(${Transpile.Quote.identifier(table)})`).all() as unknown as
      { readonly name: string, readonly hidden: number }[])
      .filter(column => column.hidden === 0)
      .map(column => column.name)

const convertedValue =
  (column: string, action: Action, before: TypeName.t): string => {
    const rendered = Transpile.Quote.identifier(column)
    if (column.toLowerCase() !== action.column.toLowerCase() || declaredEqual(before, action.type)) {
      return rendered
    }
    return Transpile.scalar(Storage.cast(
      { kind: 'column', name: [ column ] }, action.type, action.column)).sql
  }

const rebuild =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    action: Action,
    before: TypeName.t,
    collation: string | undefined,
    definition: string
  ): void => {
    const table = physicalName(name)
    const temporary = `__mssqlite_alter_${randomUUID().replaceAll('-', '')}`
    const members = alteredMembers(definition, action, collation)
    const objects = schemaObjects(db, table)
    const columns = ordinaryColumns(db, table)
    db.exec(`CREATE TABLE ${Transpile.Quote.identifier(temporary)} (${members.join(', ')})`)
    const names = columns.map(Transpile.Quote.identifier).join(', ')
    const values = columns.map(column => convertedValue(column, action, before)).join(', ')
    db.exec(
      `INSERT INTO ${Transpile.Quote.identifier(temporary)} (${names}) ` +
      `SELECT ${values} FROM ${Transpile.Quote.identifier(table)}`
    )
    dropSchemaObjects(db, objects)
    db.exec(`DROP TABLE ${Transpile.Quote.identifier(table)}`)
    db.exec(
      `ALTER TABLE ${Transpile.Quote.identifier(temporary)} ` +
      `RENAME TO ${Transpile.Quote.identifier(table)}`
    )
    recreateSchemaObjects(db, objects)
  }

const withSavepoint =
  (db: DatabaseSync, run: () => void): void => {
    const savepoint = Transpile.Quote.identifier(`alter_column_${randomUUID().replaceAll('-', '')}`)
    db.exec(`SAVEPOINT ${savepoint}`)
    try {
      run()
      db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    }
  }

type ResolvedColumn = {
  readonly objectId: number,
  readonly row: Catalog.ColumnRow,
  readonly before: TypeName.t
}

const resolveColumn =
  (db: DatabaseSync, name: Ast.QualifiedName, column: string): ResolvedColumn => {
    const objectId = Catalog.objectIdOf(db, name)
    if (objectId === undefined) {
      throw new MssqlError(`Cannot find the object '${name.join('.')}'.`, 4902, 16)
    }
    const row = Catalog.tableColumns(db, objectId).find(candidate =>
      candidate.name.toLowerCase() === column.toLowerCase())
    const before = row === undefined ? undefined : typeNameOfCatalogRow(row)
    if (row === undefined || before === undefined) {
      throw new MssqlError(
        `ALTER TABLE ALTER COLUMN failed because column '${column}' does not exist.`, 4924, 16)
    }
    return { objectId, row, before }
  }

const targetCollation =
  (action: Action): string | undefined => {
    const character = [ 'text', 'ntext' ].includes(Transpile.Type.category(action.type) ?? '')
    if (action.collate !== undefined && !character) {
      throw new MssqlError('Expression type is invalid for COLLATE clause.', 447, 16)
    }
    const collation = character ? action.collate ?? defaultCollation : undefined
    if (collation !== undefined) {
      Transpile.Collation.key(collation)
    }
    return collation
  }

const tableDefinition =
  (db: DatabaseSync, name: Ast.QualifiedName): string => {
    const table = physicalName(name)
    const schema = db.prepare(
      'SELECT sql FROM sqlite_schema WHERE type = \'table\' AND lower(name) = lower(?)'
    ).get(table) as { readonly sql: string | null } | undefined
    if (schema?.sql === null || schema?.sql === undefined) {
      throw new MssqlError(`Cannot find the object '${name.join('.')}'.`, 4902, 16)
    }
    return schema.sql
  }

const rebuildAndMaintain =
  (
    db: DatabaseSync,
    name: Ast.QualifiedName,
    action: Action,
    resolved: ResolvedColumn,
    collation: string | undefined,
    definition: string
  ): void => {
    withSavepoint(db, () => {
      rebuild(db, name, action, resolved.before, collation, definition)
      Catalog.alterColumn(db, name, action.column, action.type, collation, action.nullable)
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new MssqlError(
          'The ALTER TABLE statement conflicted with a FOREIGN KEY constraint.', 547, 16)
      }
    })
  }

const withForeignKeysDisabled =
  (db: DatabaseSync, disable: boolean, run: () => void): void => {
    if (disable) {
      db.exec('PRAGMA foreign_keys = OFF')
    }
    try {
      run()
    } finally {
      if (disable) {
        db.exec('PRAGMA foreign_keys = ON')
      }
    }
  }

/** Atomically converts and rebuilds one persisted table column. */
export const alterColumn =
  (session: Session, name: Ast.QualifiedName, action: Action): void => {
    const db = session.db
    const resolved = resolveColumn(db, name, action.column)
    if (Catalog.TypeRow.columnType(action.type) === undefined) {
      throw new MssqlError(`Column '${action.column}' has an invalid data type.`, 2715, 16)
    }
    const collation = targetCollation(action)
    validateDependencies(db, resolved.row, resolved.before, action, collation)
    const definition = tableDefinition(db, name)
    const incoming = db.prepare(
      'SELECT 1 AS found FROM "sys.foreign_keys" WHERE referenced_object_id = ? LIMIT 1'
    ).get(resolved.objectId) as { readonly found: number } | undefined
    const disableForeignKeys = incoming !== undefined && !db.isTransaction
    if (incoming !== undefined && db.isTransaction) {
      throw dependencyError(action.column)
    }
    withForeignKeysDisabled(db, disableForeignKeys, () =>
      rebuildAndMaintain(db, name, action, resolved, collation, definition))
  }
