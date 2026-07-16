import * as Transpile from '@mssqlite/transpile'
import { bindable, bindings } from './bind.ts'
import { columnsOf } from './metadata.ts'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Item, Rows } from './execute.ts'
import type { Session, Value } from './session.ts'

/** @returns result rows of a rendered SELECT with TDS column metadata. */
export const query =
  (session: Session, sql: string, variables: readonly string[]): Rows => {
    const statement = session.db.prepare(sql)
    const records = statement.all(bindings(session, variables)) as Record<string, Value>[]
    const columns = columnsOf(session.db, statement, records, session.tableVariables.values())
    const rows = records.map(record => columns.map(column => record[column.name] ?? null))
    session.rowCount = rows.length
    return { kind: 'rows', columns, rows, rowCount: rows.length }
  }

/** Emits OUTPUT rows to the client, or routes them into the INTO target table. */
export const emitOutput =
  (session: Session, output: Ast.Output, result: Rows, items: Item[]): void => {
    if (output.into === undefined) {
      items.push(result)
      return
    }
    const table = Transpile.Quote.objectName(output.into.table)
    const columns = output.into.columns === undefined ?
      '' :
      ` (${output.into.columns.map(Transpile.Quote.identifier).join(', ')})`
    const placeholders = result.columns.map(() => '?').join(', ')
    const insert = session.db.prepare(`INSERT INTO ${table}${columns} VALUES (${placeholders})`)
    for (const row of result.rows) {
      insert.run(...row.map(bindable))
    }
    // OUTPUT INTO returns no result set — the count reflects the DML itself.
    items.push({ kind: 'count', rowCount: result.rowCount })
  }

/** @returns OUTPUT items with `inserted.*` / `deleted.*` expanded to the target table's columns. */
export const expandOutputStars =
  (session: Session, target: Ast.QualifiedName, items: readonly Ast.SelectItem[]): Ast.SelectItem[] =>
    items.flatMap(item => {
      if (item.kind !== 'star') {
        return [ item ]
      }
      const qualifier = (item.qualifier?.[item.qualifier.length - 1] ?? '').toLowerCase()
      if (qualifier !== 'inserted' && qualifier !== 'deleted') {
        throw new MssqlError('OUTPUT * must be qualified with the INSERTED or DELETED pseudo-table.', 102, 15)
      }
      const columns = session.db
        .prepare(`PRAGMA table_info(${Transpile.Quote.objectName(target)})`)
        .all() as { name: string }[]
      return columns.map(column => ({
        kind: 'expression' as const,
        expression: { kind: 'column' as const, name: [ qualifier, column.name ] },
        alias: column.name
      }))
    })
