import * as Transpile from '@mssqlite/transpile'
import { bindable, bindings } from './bind.ts'
import { columnsOf } from './metadata.ts'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { ColumnHint } from '@mssqlite/transpile'
import type { Item, Rows } from './execute.ts'
import { countVisibility, type Session } from './session.ts'
import positionalRows from './positional-rows.ts'

/** @returns result rows of a rendered SELECT with TDS column metadata. */
export const query =
  (
    session: Session,
    sql: string,
    variables: readonly string[],
    hints: readonly ColumnHint[] = []
  ): Rows => {
    const statement = session.db.prepare(sql)
    const rows = positionalRows(statement, bindings(session, variables))
    const columns = columnsOf(
      session.db, statement, rows, session.tableVariables.values(), hints)
    session.rowCount = rows.length
    return { kind: 'rows', columns, rows, rowCount: rows.length, ...countVisibility(session) }
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
    items.push({ kind: 'count', rowCount: result.rowCount, ...countVisibility(session) })
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
