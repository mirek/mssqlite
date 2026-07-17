import { objectIdOf, tableColumns, type ColumnRow } from '@mssqlite/catalog'
import { BulkLoad as TdsBulkLoad, DataType, TypeInfo, Value as TdsValue } from '@mssqlite/tds'
import * as Transpile from '@mssqlite/transpile'
import { assertWritable, stateForName, withState } from './database.ts'
import { MssqlError } from './error.ts'
import * as Identity from './identity.ts'
import * as Character from './character.ts'
import { executeSql, type Parameter } from './execute.ts'
import { typeInfoOfCatalogRow } from './metadata.ts'
import { typeNameOfCatalogRow } from './table-variable.ts'
import { flushRowversion } from './rowversion.ts'
import {
  beginRequest,
  endRequest,
  type DatabaseState,
  type Session,
  type Value
} from './session.ts'
import type { StatementSync } from 'node:sqlite'
import type { Ast } from '@mssqlite/tsql'

type Parsed = {
  readonly target: readonly string[],
  readonly columns: readonly string[],
  readonly checkConstraints: boolean,
  readonly fireTriggers: boolean,
  readonly keepIdentity: boolean,
  readonly keepNulls: boolean
}

type TargetColumn = {
  readonly row: ColumnRow,
  readonly typeInfo: TypeInfo.t,
  readonly hasDefault: boolean
}

export type Plan = {
  readonly session: Session,
  /** Handle that owns the request transaction (the selected database). */
  readonly database: DatabaseState,
  /** Catalog/allocation owner of the target table. */
  readonly targetDatabase: DatabaseState,
  readonly target: Ast.QualifiedName,
  readonly table: string,
  readonly columns: readonly TargetColumn[],
  readonly identity: Identity.Identity | undefined,
  readonly checkConstraints: boolean,
  readonly fireTriggers: boolean,
  readonly keepIdentity: boolean,
  readonly keepNulls: boolean
}

export type Loader = {
  readonly plan: Plan,
  readonly savepoint: string,
  readonly statements: Map<string, StatementSync>,
  readonly previousRowCount: number,
  readonly previousIdentity: Value,
  readonly previousScopeIdentity: Value,
  readonly previousIdentityVersion: number,
  rowCount: number,
  lastIdentity: Value,
  active: boolean
}

const syntax =
  (): never => {
    throw new MssqlError('Incorrect syntax near INSERT BULK.', 102, 15)
  }

const skipSpace =
  (sql: string, start: number): number => {
    let at = start
    while (/\s/.test(sql[at] ?? '')) {
      at++
    }
    return at
  }

const identifier =
  (sql: string, start: number): { readonly value: string, readonly at: number } | undefined => {
    const at = skipSpace(sql, start)
    const opening = sql[at]
    if (opening === '[' || opening === '"') {
      const closing = opening === '[' ? ']' : '"'
      let value = ''
      for (let index = at + 1; index < sql.length; index++) {
        if (sql[index] !== closing) {
          value += sql[index]
          continue
        }
        if (sql[index + 1] === closing) {
          value += closing
          index++
          continue
        }
        return { value, at: index + 1 }
      }
      return undefined
    }
    const match = /^[a-z#@_][\w$#@]*/i.exec(sql.slice(at))
    return match === null ? undefined : { value: match[0], at: at + match[0].length }
  }

const qualifiedName =
  (sql: string, start: number): { readonly value: readonly string[], readonly at: number } | undefined => {
    const parts: string[] = []
    let next = start
    for (;;) {
      const part = identifier(sql, next)
      if (part === undefined || part.value === '') {
        return undefined
      }
      parts.push(part.value)
      next = skipSpace(sql, part.at)
      if (sql[next] !== '.') {
        return parts.length <= 3 ? { value: parts, at: next } : undefined
      }
      next++
    }
  }

const closingParenthesis =
  (sql: string, opening: number): number | undefined => {
    let depth = 0
    let bracket = false
    let quote: string | undefined
    for (let at = opening; at < sql.length; at++) {
      const char = sql[at]
      if (bracket) {
        if (char === ']' && sql[at + 1] === ']') {
          at++
        } else if (char === ']') {
          bracket = false
        }
        continue
      }
      if (quote !== undefined) {
        if (char === quote && sql[at + 1] === quote) {
          at++
        } else if (char === quote) {
          quote = undefined
        }
        continue
      }
      if (char === '[') {
        bracket = true
      } else if (char === '"' || char === '\'') {
        quote = char
      } else if (char === '(') {
        depth++
      } else if (char === ')' && --depth === 0) {
        return at
      }
    }
    return undefined
  }

const splitColumns =
  (sql: string): readonly string[] => {
    const entries: string[] = []
    let start = 0
    let depth = 0
    let bracket = false
    for (let at = 0; at <= sql.length; at++) {
      const char = sql[at]
      if (char === '[') {
        bracket = true
      } else if (char === ']' && bracket && sql[at + 1] === ']') {
        at++
      } else if (char === ']') {
        bracket = false
      } else if (!bracket && char === '(') {
        depth++
      } else if (!bracket && char === ')') {
        depth--
      } else if (!bracket && depth === 0 && (char === ',' || at === sql.length)) {
        entries.push(sql.slice(start, at))
        start = at + 1
      }
    }
    return entries.map(entry => {
      const name = identifier(entry, 0)
      if (name === undefined || entry.slice(name.at).trim() === '') {
        return syntax()
      }
      return name.value
    })
  }

const parse =
  (sql: string): Parsed | undefined => {
    const prefix = /^\s*insert\s+bulk\b/i.exec(sql)
    if (prefix === null) {
      return undefined
    }
    const target = qualifiedName(sql, prefix[0].length)
    if (target === undefined || sql[target.at] !== '(') {
      return syntax()
    }
    const close = closingParenthesis(sql, target.at)
    if (close === undefined) {
      return syntax()
    }
    const columns = splitColumns(sql.slice(target.at + 1, close))
    if (columns.length === 0 || new Set(columns.map(name => name.toLowerCase())).size !== columns.length) {
      return syntax()
    }
    const trailing = sql.slice(close + 1).trim().replace(/;$/, '').trim()
    if (trailing !== '' && !/^with\s*\([\s\S]*\)$/i.test(trailing)) {
      return syntax()
    }
    const options = trailing.toUpperCase()
    return {
      target: target.value,
      columns,
      checkConstraints: /\bCHECK_CONSTRAINTS\b/.test(options),
      fireTriggers: /\bFIRE_TRIGGERS\b/.test(options),
      keepIdentity: /\bKEEPIDENTITY\b/.test(options),
      keepNulls: /\bKEEP_NULLS\b/.test(options)
    }
  }

const targetColumns =
  (
    database: DatabaseState,
    target: readonly string[],
    names: readonly string[]
  ): readonly TargetColumn[] => {
    const local = target.length > 1 ? target.slice(-2) : target
    const objectId = objectIdOf(database.db, local)
    if (objectId === undefined) {
      throw new MssqlError(`Invalid object name '${target.join('.')}'.`, 208, 16)
    }
    const defaults = new Set((database.db.prepare(
      'SELECT parent_column_id FROM "sys.default_constraints" WHERE parent_object_id = ?'
    ).all(objectId) as unknown as { parent_column_id: number }[])
      .map(row => row.parent_column_id))
    const rows = tableColumns(database.db, objectId)
    const available = new Map(rows.map(row => [ row.name.toLowerCase(), row ]))
    return names.map(name => {
      const row = available.get(name.toLowerCase())
      if (row === undefined) {
        throw new MssqlError(`Invalid column name '${name}'.`, 207, 16)
      }
      if (row.is_computed !== 0 || row.system_type_id === 189) {
        throw new MssqlError(`The column '${row.name}' cannot be modified.`, 271, 16)
      }
      return {
        row,
        typeInfo: typeInfoOfCatalogRow(row),
        hasDefault: defaults.has(row.column_id)
      }
    })
  }

/** Recognizes and validates the INSERT BULK setup batch sent before packet type 7. */
export const prepareBulkLoad =
  (session: Session, sql: string): Plan | undefined => {
    const parsed = parse(sql)
    if (parsed === undefined) {
      return undefined
    }
    const targetDatabase = stateForName(session, parsed.target)
    assertWritable(targetDatabase)
    const target = targetColumns(targetDatabase, parsed.target, parsed.columns)
    if (!parsed.keepIdentity && target.some(column => column.row.is_identity !== 0)) {
      throw new MssqlError('Explicit value must be specified for identity column only with KEEPIDENTITY.', 544, 16)
    }
    return {
      session,
      database: session.databaseState,
      targetDatabase,
      target: parsed.target,
      table: Transpile.Quote.objectName(targetDatabase === session.databaseState &&
        parsed.target.length > 1 ? parsed.target.slice(-2) : parsed.target),
      columns: target,
      identity: Identity.resolve(session, parsed.target),
      checkConstraints: parsed.checkConstraints,
      fireTriggers: parsed.fireTriggers,
      keepIdentity: parsed.keepIdentity,
      keepNulls: parsed.keepNulls
    }
  }

const verifyMetadata =
  (plan: Plan, columns: readonly TdsBulkLoad.Column[]): void => {
    if (columns.length !== plan.columns.length) {
      throw new MssqlError('Bulk load column metadata does not match INSERT BULK.', 4815, 16)
    }
    columns.forEach((column, index) => {
      if (column.name.toLowerCase() !== plan.columns[index]?.row.name.toLowerCase()) {
        throw new MssqlError('Bulk load column metadata does not match INSERT BULK.', 4815, 16)
      }
    })
  }

const runCurrent =
  <T>(session: Session, run: () => T): T => {
    const previous = session.server.current
    session.server.current = session
    try {
      return run()
    } finally {
      session.server.current = previous
    }
  }

const runPlan =
  <T>(plan: Plan, run: () => T): T =>
    runCurrent(plan.session, () => withState(plan.session, plan.database, run))

/** Starts an atomic bulk request after validating its wire metadata. */
export const beginBulkLoad =
  (plan: Plan, columns: readonly TdsBulkLoad.Column[]): Loader => {
    verifyMetadata(plan, columns)
    const savepoint = `__mssqlite_bulk_${plan.session.spid}`
    beginRequest(plan.session, 'INSERT BULK')
    try {
      runPlan(plan, () => plan.database.db.exec(
        `SAVEPOINT ${Transpile.Quote.identifier(savepoint)}`))
    } catch (error) {
      endRequest(plan.session)
      throw error
    }
    return {
      plan,
      savepoint,
      statements: new Map(),
      previousRowCount: plan.session.rowCount,
      previousIdentity: plan.session.lastIdentity,
      previousScopeIdentity: plan.session.scopeIdentity,
      previousIdentityVersion: plan.session.identityVersion,
      rowCount: 0,
      lastIdentity: plan.session.lastIdentity,
      active: true
    }
  }

const integer =
  (value: TdsValue.t, bytes: number): number | bigint => {
    let resolved: bigint
    try {
      resolved = typeof value === 'bigint' ? value : BigInt(value as string | number | boolean)
    } catch {
      throw new MssqlError('Error converting data type for bulk load.', 8114, 16)
    }
    const ranges: Record<number, readonly [ bigint, bigint ]> = {
      1: [ 0n, 255n ],
      2: [ -32768n, 32767n ],
      4: [ -2147483648n, 2147483647n ],
      8: [ -9223372036854775808n, 9223372036854775807n ]
    }
    const [ minimum, maximum ] = ranges[bytes] ?? ranges[4] as readonly [ bigint, bigint ]
    if (resolved < minimum || resolved > maximum) {
      throw new MssqlError('Arithmetic overflow error converting expression to data type int.', 8115, 16)
    }
    return bytes === 8 ? resolved : Number(resolved)
  }

const converted =
  (column: TargetColumn, value: TdsValue.t): Value => {
    if (value === null) {
      return null
    }
    const type = column.typeInfo
    if (type.type === DataType.DataType.intN) {
      return integer(value, type.maxLength ?? 4)
    }
    const declared = typeNameOfCatalogRow(column.row)
    if (declared !== undefined && Character.family(declared) !== undefined) {
      return Character.store(String(value), declared, column.row.name)
    }
    try {
      const bytes = TdsValue.encodeBare(type, value)
      if (!TypeInfo.plp(type) && type.maxLength !== undefined && bytes.byteLength > type.maxLength) {
        throw new MssqlError(
          `String or binary data would be truncated in column '${column.row.name}'.`, 2628, 16)
      }
      const result = TdsValue.decodeBare(type, bytes)
      if (result instanceof Date) {
        return result.toISOString()
      }
      return result
    } catch (error) {
      if (error instanceof MssqlError) {
        throw error
      }
      throw new MssqlError(
        `Error converting data type for bulk column '${column.row.name}'.`, 8114, 16)
    }
  }

const included =
  (plan: Plan, row: readonly TdsValue.t[]): readonly number[] =>
    plan.columns.flatMap((column, index) =>
      !plan.keepNulls && column.hasDefault && row[index] === null ? [] : [ index ])

const statement =
  (loader: Loader, indexes: readonly number[], generatedIdentity: boolean): StatementSync => {
    const key = `${indexes.join(',')}|${generatedIdentity ? 'identity' : ''}`
    const cached = loader.statements.get(key)
    if (cached !== undefined) {
      return cached
    }
    const names = indexes.map(index => loader.plan.columns[index]?.row.name ?? '')
    if (generatedIdentity && loader.plan.identity !== undefined) {
      names.push(loader.plan.identity.column)
    }
    const sql = names.length === 0 ?
      `INSERT INTO ${loader.plan.table} DEFAULT VALUES` :
      `INSERT INTO ${loader.plan.table} (${names.map(Transpile.Quote.identifier).join(', ')}) ` +
      `VALUES (${names.map(() => '?').join(', ')})`
    const prepared = loader.plan.database.db.prepare(sql)
    loader.statements.set(key, prepared)
    return prepared
  }

const triggeredInsert =
  (loader: Loader, indexes: readonly number[], values: readonly Value[]): void => {
    const parameters: Parameter[] = values.map((value, at) => ({
      name: `@bulk${at + 1}`,
      value
    }))
    const sql = indexes.length === 0 ?
      `INSERT INTO ${loader.plan.table} DEFAULT VALUES` :
      `INSERT INTO ${loader.plan.table} (${indexes.map(index =>
        Transpile.Quote.identifier(loader.plan.columns[index]?.row.name ?? '')).join(', ')}) ` +
      `VALUES (${parameters.map(parameter => parameter.name).join(', ')})`
    executeSql(loader.plan.session, sql, parameters)
  }

const withBulkIdentityInsert =
  (plan: Plan, enabled: boolean, run: () => void): void => {
    if (!enabled) {
      run()
      return
    }
    const { session } = plan
    const previous = session.identityInsert
    session.identityInsert = undefined
    Identity.setInsert(session, plan.target, true)
    try {
      run()
    } finally {
      session.identityInsert = previous
    }
  }

/** Inserts complete decoded rows through cached statements inside the bulk savepoint. */
export const writeBulkRows =
  (loader: Loader, rows: readonly (readonly TdsValue.t[])[]): void => {
    const mutable = loader
    if (!mutable.active) {
      throw new Error('Bulk loader is no longer active.')
    }
    const session = mutable.plan.session
    const previousAllocation = session.allocationDatabaseState
    session.allocationDatabaseState = mutable.plan.targetDatabase
    try {
      runPlan(mutable.plan, () => {
        for (const row of rows) {
          if (row.length !== mutable.plan.columns.length) {
            throw new MssqlError('Bulk row does not match column metadata.', 4816, 16)
          }
          const indexes = included(mutable.plan, row)
          let values = indexes.map(index =>
            converted(mutable.plan.columns[index] as TargetColumn, row[index] ?? null))
          if (mutable.plan.fireTriggers) {
            if (mutable.plan.targetDatabase !== mutable.plan.database) {
              throw new MssqlError('FIRE_TRIGGERS is unsupported for cross-database bulk load.', 40000, 16)
            }
            const explicit = indexes.some(index =>
              mutable.plan.columns[index]?.row.is_identity !== 0)
            withBulkIdentityInsert(mutable.plan, explicit, () =>
              triggeredInsert(mutable, indexes, values))
            mutable.lastIdentity = mutable.plan.session.lastIdentity
          } else {
            const identityAt = indexes.findIndex(index =>
              mutable.plan.columns[index]?.row.is_identity !== 0)
            let generatedIdentity = false
            if (mutable.plan.identity !== undefined) {
              if (identityAt >= 0) {
                const explicit = Identity.explicitValue(
                  session, mutable.plan.target, values[identityAt] ?? null)
                values = values.map((value, index) => index === identityAt ? explicit : value)
                mutable.lastIdentity = explicit
              } else {
                generatedIdentity = true
                const generated = Identity.nextValue(session, mutable.plan.target)
                values = [ ...values, generated ]
                mutable.lastIdentity = generated
              }
            }
            const bindings = values.map(value => typeof value === 'boolean' ? (value ? 1 : 0) : value)
            statement(mutable, indexes, generatedIdentity).run(...bindings)
          }
          mutable.rowCount++
        }
      })
    } finally {
      session.allocationDatabaseState = previousAllocation
    }
  }

/** Commits a completed bulk request and publishes row-count/session identity state. */
export const finishBulkLoad =
  (loader: Loader): number => {
    const mutable = loader
    if (!mutable.active) {
      throw new Error('Bulk loader is no longer active.')
    }
    runPlan(mutable.plan, () => mutable.plan.database.db.exec(
      `RELEASE SAVEPOINT ${Transpile.Quote.identifier(mutable.savepoint)}`))
    mutable.active = false
    const session = mutable.plan.session
    session.rowCount = mutable.rowCount
    if (mutable.rowCount > 0 && mutable.plan.identity !== undefined && !mutable.plan.fireTriggers) {
      session.pendingIdentity = mutable.lastIdentity
      Identity.publishPending(session)
    }
    endRequest(session)
    flushRowversion(session.server)
    Identity.flushIdentities(session)
    return mutable.rowCount
  }

/** Rolls back all rows from an incomplete, failed, or canceled bulk request. */
export const abortBulkLoad =
  (loader: Loader): void => {
    const mutable = loader
    if (!mutable.active) {
      return
    }
    runPlan(mutable.plan, () => {
      if (mutable.plan.database.db.isTransaction) {
        mutable.plan.database.db.exec(
          `ROLLBACK TO SAVEPOINT ${Transpile.Quote.identifier(mutable.savepoint)}`)
        mutable.plan.database.db.exec(
          `RELEASE SAVEPOINT ${Transpile.Quote.identifier(mutable.savepoint)}`)
      }
    })
    mutable.active = false
    const session = mutable.plan.session
    session.rowCount = mutable.previousRowCount
    session.lastIdentity = mutable.previousIdentity
    session.scopeIdentity = mutable.previousScopeIdentity
    session.identityVersion = mutable.previousIdentityVersion
    endRequest(session)
    flushRowversion(session.server)
    Identity.flushIdentities(session)
  }
