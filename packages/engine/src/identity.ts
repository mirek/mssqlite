import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { MssqlError } from './error.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { DatabaseState, Session, Value } from './session.ts'
import type { DatabaseSync } from 'node:sqlite'

export type Identity = {
  readonly objectId: number | undefined,
  readonly columnId: number | undefined,
  readonly name: Ast.QualifiedName,
  readonly column: string,
  readonly type: TypeName.t,
  readonly seed: bigint,
  readonly increment: bigint,
  last: bigint | null,
  dirty: boolean
}

/** @returns lowercased schema/table registry key. */
export const identityKey =
  (name: Ast.QualifiedName | string): string => {
    const parts = typeof name === 'string' ? name.split('.') : [ ...name ]
    const scoped = parts.length > 2 ? parts.slice(-2) : parts
    return (scoped.length === 2 ? `${scoped[0]}.${scoped[1]}` : `dbo.${scoped[0]}`).toLowerCase()
  }

const typeOf =
  (row: Catalog.IdentityRow): TypeName.t => ({
    name: row.type_name,
    args: [ 'decimal', 'numeric' ].includes(row.type_name) ? [ row.precision, row.scale ] : []
  })

const currentFromRows =
  (db: DatabaseSync, row: Catalog.IdentityRow): bigint | null => {
    try {
      const aggregate = BigInt(row.increment_value) < 0n ? 'MIN' : 'MAX'
      const table = Transpile.Quote.objectName([ row.schema_name, row.table_name ])
      const column = Transpile.Quote.identifier(row.column_name)
      const found = db.prepare(`SELECT ${aggregate}(${column}) AS value FROM ${table}`).get() as
        { value: number | bigint | string | null }
      return found.value === null ? null : integerOf(found.value)
    } catch {
      return null
    }
  }

/** Hydrates a database's identity allocation registry from its catalog. */
export const loadIdentities =
  (db: DatabaseSync): Map<string, Identity> =>
    new Map(Catalog.identityRows(db).map(row => {
      const name = [ row.schema_name, row.table_name ]
      const identity: Identity = {
        objectId: row.object_id,
        columnId: row.column_id,
        name,
        column: row.column_name,
        type: typeOf(row),
        seed: BigInt(row.seed_value),
        increment: BigInt(row.increment_value),
        last: row.last_value === null ? currentFromRows(db, row) : BigInt(row.last_value),
        dirty: false
      }
      return [ identityKey(name), identity ]
    }))

/** Reloads definitions after table DDL while retaining unflushed counters. */
export const reloadIdentities =
  (database: DatabaseState): void => {
    const prior = [ ...database.identities.values() ]
    const loaded = loadIdentities(database.db)
    for (const [ key, identity ] of loaded) {
      const existing = prior.find(candidate =>
        candidate.objectId === identity.objectId && candidate.columnId === identity.columnId)
      if (existing !== undefined && existing.dirty) {
        identity.last = existing.last
        identity.dirty = true
      }
      loaded.set(key, identity)
    }
    database.identities.clear()
    for (const [ key, identity ] of loaded) {
      database.identities.set(key, identity)
    }
  }

/** Persists dirty counters once no SQLite transaction can roll them back. */
export const flushIdentities =
  (session: Session): void => {
    for (const database of session.server.databases.values()) {
      if (database.db.isTransaction) {
        continue
      }
      for (const identity of database.identities.values()) {
        if (!identity.dirty || identity.objectId === undefined || identity.columnId === undefined) {
          continue
        }
        Catalog.updateIdentityValue(
          database.db, identity.objectId, identity.columnId,
          identity.last?.toString() ?? null)
        identity.dirty = false
      }
    }
  }

const bounds =
  (type: TypeName.t): readonly [ minimum: bigint, maximum: bigint ] => {
    switch (type.name) {
      case 'tinyint':
        return [ 0n, 255n ]
      case 'smallint':
        return [ -32768n, 32767n ]
      case 'int':
      case 'integer':
        return [ -2147483648n, 2147483647n ]
      case 'bigint':
        return [ -9223372036854775808n, 9223372036854775807n ]
      case 'decimal':
      case 'numeric': {
        const precision = typeof type.args[0] === 'number' ? type.args[0] : 18
        const scale = typeof type.args[1] === 'number' ? type.args[1] : 0
        if (scale !== 0 || precision < 1 || precision > 38) {
          break
        }
        const maximum = (10n ** BigInt(precision)) - 1n
        return [ -maximum, maximum ]
      }
      default:
        break
    }
    throw new MssqlError(
      `The data type '${type.name}' is invalid for use with the IDENTITY property.`,
      2749, 16)
  }

const validatedDefinition =
  (column: Ast.ColumnDefinition): void => {
    const identity = column.identity
    if (identity === undefined) {
      return
    }
    const [ minimum, maximum ] = bounds(column.type)
    let seed: bigint
    let increment: bigint
    try {
      seed = BigInt(identity.seed)
      increment = BigInt(identity.increment)
    } catch {
      throw new MssqlError('Identity seed and increment must be integer constants.', 102, 15)
    }
    if (increment === 0n) {
      throw new MssqlError('The identity increment must not be zero.', 2747, 16)
    }
    if (seed < minimum || seed > maximum || increment < minimum || increment > maximum) {
      throw new MssqlError(
        `Arithmetic overflow error converting IDENTITY to data type ${column.type.name}.`,
        8115, 16)
    }
  }

/** Validates the one-column rule and each identity definition. */
export const validateColumns =
  (columns: readonly Ast.ColumnDefinition[]): void => {
    const identities = columns.filter(column => column.identity !== undefined)
    if (identities.length > 1) {
      throw new MssqlError('Multiple identity columns specified for table. Only one identity column per table is allowed.',
        2744, 16)
    }
    identities.forEach(validatedDefinition)
  }

/** Creates runtime state for a table variable identity definition. */
export const temporaryIdentity =
  (name: Ast.QualifiedName, columns: readonly Ast.ColumnDefinition[]): Identity | undefined => {
    const column = columns.find(candidate => candidate.identity !== undefined)
    if (column?.identity === undefined) {
      return undefined
    }
    return {
      objectId: undefined,
      columnId: undefined,
      name,
      column: column.name,
      type: column.type,
      seed: BigInt(column.identity.seed),
      increment: BigInt(column.identity.increment),
      last: null,
      dirty: false
    }
  }

const databaseFor =
  (session: Session, name: Ast.QualifiedName): DatabaseState | undefined => {
    if (name.length < 3) {
      return session.databaseState
    }
    return session.server.databases.get((name[name.length - 3] ?? '').toLowerCase())
  }

/** Resolves a persistent or table-variable identity by its physical target name. */
export const resolve =
  (session: Session, name: Ast.QualifiedName): Identity | undefined => {
    const physical = (name[name.length - 1] ?? '').toLowerCase()
    const variable = [ ...session.tableVariables.values() ].find(candidate =>
      (candidate.table[candidate.table.length - 1] ?? '').toLowerCase() === physical)
    if (variable !== undefined) {
      return variable.identity
    }
    return databaseFor(session, name)?.identities.get(identityKey(name))
  }

const resolved =
  (session: Session, name: Ast.QualifiedName): { database: DatabaseState, identity: Identity } | undefined => {
    const identity = resolve(session, name)
    const database = databaseFor(session, name)
    return identity === undefined || database === undefined ? undefined : { database, identity }
  }

const valueOf =
  (identity: Identity, value: bigint): Value =>
    [ 'decimal', 'numeric' ].includes(identity.type.name) ? value.toString() :
      value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ?
        Number(value) : value

const integerOf =
  (value: Value): bigint => {
    if (typeof value === 'bigint') {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
      return BigInt(value)
    }
    if (typeof value === 'string' && /^[+-]?\d+(?:\.0+)?$/.test(value.trim())) {
      return BigInt(value.trim().split('.')[0] ?? '0')
    }
    throw new MssqlError('Explicit value for an identity column must be an integer.', 8114, 16)
  }

const checked =
  (identity: Identity, value: bigint): bigint => {
    const [ minimum, maximum ] = bounds(identity.type)
    if (value < minimum || value > maximum) {
      throw new MssqlError(
        `Arithmetic overflow error converting IDENTITY to data type ${identity.type.name}.`,
        8115, 16, 1, { statementTerminating: true })
    }
    return value
  }

const pending =
  (session: Session, identity: Identity, value: bigint): Value => {
    const result = valueOf(identity, value)
    session.pendingIdentity = result
    return result
  }

/** Reserves one generated value outside SQLite's rollback state. */
export const nextValue =
  (session: Session, name: Ast.QualifiedName): Value => {
    const found = resolved(session, name)
    if (found === undefined) {
      throw new MssqlError(`Table '${name.join('.')}' does not have the identity property.`, 8106, 16)
    }
    if (found.database.readOnly) {
      throw new MssqlError(
        `Failed to update database '${found.database.name}' because the database is read-only.`, 3906, 16)
    }
    const identity = found.identity
    const value = checked(identity, identity.last === null ? identity.seed : identity.last + identity.increment)
    identity.last = value
    identity.dirty = identity.objectId !== undefined
    return pending(session, identity, value)
  }

/** Accepts one explicit identity value and advances the counter when required. */
export const explicitValue =
  (session: Session, name: Ast.QualifiedName, input: Value): Value => {
    const found = resolved(session, name)
    if (found === undefined) {
      throw new MssqlError(`Table '${name.join('.')}' does not have the identity property.`, 8106, 16)
    }
    const identity = found.identity
    const value = checked(identity, integerOf(input))
    if (identity.last === null ||
      (identity.increment > 0n && value > identity.last) ||
      (identity.increment < 0n && value < identity.last)) {
      identity.last = value
      identity.dirty = identity.objectId !== undefined
    }
    return pending(session, identity, value)
  }

/** Publishes a successful insert's captured identity into session functions. */
export const publishPending =
  (session: Session, global = true): void => {
    if (session.pendingIdentity === null) {
      return
    }
    session.scopeIdentity = session.pendingIdentity
    if (global) {
      session.lastIdentity = session.pendingIdentity
      session.identityVersion++
    }
  }

/** Resets a table's current value so its next allocation returns the seed. */
export const reset =
  (session: Session, name: Ast.QualifiedName): void => {
    const found = resolved(session, name)
    if (found === undefined) {
      return
    }
    const { database, identity } = found
    if (session.transactionCount > 0) {
      const key = `${database.id}:${identityKey(name)}`
      if (!session.identityResets.has(key)) {
        session.identityResets.set(key, { identity, last: identity.last, dirty: identity.dirty })
      }
    }
    identity.last = null
    identity.dirty = identity.objectId !== undefined
  }

/** Keeps transactional TRUNCATE resets after the outer transaction commits. */
export const commitResets =
  (session: Session): void => {
    session.identityResets.clear()
  }

/** Restores identity state when a transaction containing TRUNCATE rolls back. */
export const rollbackResets =
  (session: Session): void => {
    for (const snapshot of session.identityResets.values()) {
      snapshot.identity.last = snapshot.last
      snapshot.identity.dirty = snapshot.dirty
    }
    session.identityResets.clear()
  }

/** @returns IDENT_CURRENT semantics: last value, or seed before first use/after TRUNCATE. */
export const current =
  (session: Session, table: string): Value => {
    const identity = resolve(session, table.split('.'))
    return identity === undefined ? null : valueOf(identity, identity.last ?? identity.seed)
  }

/** Enables or disables explicit identity input for one table in this session. */
export const setInsert =
  (session: Session, table: Ast.QualifiedName, enabled: boolean): void => {
    const identity = resolve(session, table)
    const database = databaseFor(session, table)
    if (identity === undefined || database === undefined) {
      throw new MssqlError(
        `Table '${table.join('.')}' does not have the identity property. Cannot perform SET operation.`,
        8106, 16)
    }
    const key = `${database.id}:${identityKey(table)}`
    const active = session.identityInsert
    if (enabled) {
      if (active !== undefined && active.key !== key) {
        throw new MssqlError(
          `IDENTITY_INSERT is already ON for table '${active.display}'. Cannot perform SET operation for table '${table.join('.')}'.`,
          8107, 16)
      }
      session.identityInsert = {
        key,
        display: `${database.name}.${identityKey(table)}`
      }
    } else if (active?.key === key) {
      session.identityInsert = undefined
    }
  }

/** Throws error 544 unless this session enabled explicit input for the target. */
export const assertExplicitAllowed =
  (session: Session, table: Ast.QualifiedName): void => {
    const database = databaseFor(session, table)
    const key = database === undefined ? '' : `${database.id}:${identityKey(table)}`
    if (session.identityInsert?.key !== key) {
      throw new MssqlError(
        `Cannot insert explicit value for identity column in table '${table[table.length - 1] ?? ''}' when IDENTITY_INSERT is set to OFF.`,
        544, 16, 1, { statementTerminating: true })
    }
  }

const tableArgument =
  (table: Ast.QualifiedName): Ast.Expression =>
    ({ kind: 'string', value: table.join('.'), national: false })

/** AST expression reserving one generated identity value. */
export const nextExpression =
  (table: Ast.QualifiedName): Ast.Expression =>
    ({ kind: 'call', name: [ 'mssqlite_next_identity' ], args: [ tableArgument(table) ] })

/** AST expression recording one explicit identity value. */
export const explicitExpression =
  (table: Ast.QualifiedName, value: Ast.Expression): Ast.Expression =>
    ({ kind: 'call', name: [ 'mssqlite_explicit_identity' ], args: [ tableArgument(table), value ] })
