import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Server } from './session.ts'
import type { DatabaseSync } from 'node:sqlite'

const maximum = 0xffff_ffff_ffff_ffffn

export type RowversionState = {
  current: bigint,
  dirty: boolean
}

/** @returns whether a declared type is SQL Server's rowversion/timestamp type. */
export const isRowversionType =
  (type: Ast.ColumnDefinition['type']): boolean =>
    type.name === 'rowversion' || type.name === 'timestamp'

/** Validates rowversion column shape and the one-column-per-table rule. */
export const validateRowversionColumns =
  (columns: readonly Ast.ColumnDefinition[], existing = 0): void => {
    const rowversions = columns.filter(column => isRowversionType(column.type))
    if (existing + rowversions.length > 1) {
      throw new MssqlError('A table can only have one timestamp column.', 2738, 16)
    }
    for (const column of rowversions) {
      if (column.type.args.length > 0) {
        throw new MssqlError('The rowversion data type cannot have a length.', 2716, 16)
      }
      if (column.default_ !== undefined) {
        throw new MssqlError(
          `Defaults cannot be created on columns of data type timestamp. Column '${column.name}' has an invalid default.`,
          1755, 16)
      }
      if (column.identity !== undefined) {
        throw new MssqlError('The timestamp data type is invalid for use with IDENTITY.', 2749, 16)
      }
      if (column.rowguidcol === true || column.collate !== undefined) {
        throw new MssqlError(`Column '${column.name}' has an invalid constraint for data type timestamp.`, 1755, 16)
      }
    }
  }

/** @returns an eight-byte, network-order binary representation. */
export const bytesOf =
  (value: bigint): Uint8Array => {
    const bytes = new Uint8Array(8)
    let remaining = value
    for (let index = 7; index >= 0; index--) {
      bytes[index] = Number(remaining & 0xffn)
      remaining >>= 8n
    }
    return bytes
  }

/** Atomically reserves one database-wide rowversion value. */
export const nextRowversionValue =
  (server: Server): Uint8Array => {
    const state = server.current?.allocationDatabaseState?.rowversion ?? server.rowversion
    if (state.current >= maximum) {
      throw new MssqlError('The database timestamp counter has reached its maximum value.', 2739, 16)
    }
    state.current++
    state.dirty = true
    return bytesOf(state.current)
  }

/** Writes dirty allocation state once no user transaction can roll it back. */
export const flushRowversion =
  (server: Server): void => {
    for (const database of server.databases.values()) {
      const state = database.rowversion
      if (database.db.isTransaction || !state.dirty) {
        continue
      }
      Catalog.updateRowversionValue(database.db, state.current.toString())
      state.dirty = false
    }
  }

/** @returns the current @@DBTS value without allocating a new version. */
export const currentRowversion =
  (server: Server): Uint8Array =>
    bytesOf(server.rowversion.current)

const triggerNames =
  (table: Ast.QualifiedName, column: string): readonly [ string, string ] => {
    const key = [ ...table.slice(-2), column ].join('_')
    return [ `__mssqlite_rowversion_${key}_insert`, `__mssqlite_rowversion_${key}_update` ]
  }

/** Removes the internal automatic-value triggers for one rowversion column. */
export const removeRowversionTriggers =
  (db: DatabaseSync, table: Ast.QualifiedName, column: string): void => {
    for (const name of triggerNames(table, column)) {
      db.exec(`DROP TRIGGER IF EXISTS ${Transpile.Quote.identifier(name)}`)
      db.exec(`DROP TRIGGER IF EXISTS temp.${Transpile.Quote.identifier(name)}`)
    }
  }

/** Installs fallback triggers for indirect writes such as MERGE and cascades. */
export const installRowversionTriggers =
  (db: DatabaseSync, table: Ast.QualifiedName, column: string): void => {
    removeRowversionTriggers(db, table, column)
    const temporary = (table[table.length - 1] ?? '').startsWith('#')
    const target = Transpile.Quote.objectName(table)
    const triggerTarget = temporary ? target.slice('temp.'.length) : target
    const prefix = temporary ? 'CREATE TEMP TRIGGER' : 'CREATE TRIGGER'
    const [ insertName, updateName ] = triggerNames(table, column)
    const quotedColumn = Transpile.Quote.identifier(column)
    db.exec(
      `${prefix} ${Transpile.Quote.identifier(insertName)} AFTER INSERT ON ${triggerTarget} ` +
      `FOR EACH ROW WHEN NEW.${quotedColumn} IS NULL BEGIN ` +
      `UPDATE ${triggerTarget} SET ${quotedColumn} = mssqlite_next_rowversion() WHERE rowid = NEW.rowid; END`
    )
    db.exec(
      `${prefix} ${Transpile.Quote.identifier(updateName)} AFTER UPDATE ON ${triggerTarget} ` +
      `FOR EACH ROW WHEN NEW.${quotedColumn} IS OLD.${quotedColumn} BEGIN ` +
      `UPDATE ${triggerTarget} SET ${quotedColumn} = mssqlite_next_rowversion() WHERE rowid = NEW.rowid; END`
    )
  }

/** Stamps existing rows after ALTER TABLE ADD rowversion. */
export const populateRowversion =
  (db: DatabaseSync, table: Ast.QualifiedName, column: string): void => {
    const target = Transpile.Quote.objectName(table)
    const quotedColumn = Transpile.Quote.identifier(column)
    db.exec(
      `UPDATE ${target} SET ${quotedColumn} = mssqlite_next_rowversion() WHERE ${quotedColumn} IS NULL`
    )
  }

/** AST expression allocating one rowversion value inside SQLite. */
export const nextRowversionExpression =
  (): Ast.Expression =>
    ({ kind: 'call', name: [ 'mssqlite_next_rowversion' ], args: [] })
