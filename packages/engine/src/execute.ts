import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { parse } from '@mssqlite/tsql'
import { bindable, bindings } from './bind.ts'
import { emitOutput, expandOutputStars, query } from './output.ts'
import { executeMerge } from './merge.ts'
import {
  defineSequence,
  flushSequences,
  redefineSequence,
  removeSequence
} from './sequence.ts'
import {
  declareTableVariable,
  columnsOfTable,
  resolveTableVariableExpression,
  resolveTableVariables,
  withTableVariableScope
} from './table-variable.ts'
import { BatchError, MssqlError, of as errorOf } from './error.ts'
import { columnsOf, type Column } from './metadata.ts'
import * as DecimalExact from './decimal.ts'
import type { Ast } from '@mssqlite/tsql'
import {
  functionKey,
  countVisibility,
  procedureKey,
  triggerKey,
  withCursorScope,
  type Cursor,
  type Procedure,
  type Server,
  type Session,
  type Trigger,
  type UserFunction,
  type Value,
  type Variable
} from './session.ts'

/** Result set of a SELECT. */
export type Rows = {
  readonly kind: 'rows',
  readonly columns: readonly Column[],
  readonly rows: readonly (readonly Value[])[],
  readonly rowCount: number
  readonly countValid?: false
}

/** Row count of a DML statement. */
export type Count = {
  readonly kind: 'count',
  readonly rowCount: number
  readonly countValid?: false
}

/** Informational message (PRINT). */
export type Message = {
  readonly kind: 'message',
  readonly text: string
}

/** Recoverable statement error retained in batch result order. */
export type ErrorItem = {
  readonly kind: 'error',
  readonly error: MssqlError
}

/** Batch execution item. */
export type Item =
  | Rows
  | Count
  | Message
  | ErrorItem

/** Control-flow signal raised by BREAK / CONTINUE / RETURN. */
type Signal =
  'break' | 'continue' | 'return' | undefined

/** @returns scalar value of a T-SQL expression evaluated in session context. */
export const evaluate =
  (session: Session, expression: Ast.Expression): Value => {
    const rendered = Transpile.scalar(resolveTableVariableExpression(session, expression))
    const statement = session.db.prepare(`SELECT (${rendered.sql}) AS value`)
    const row = statement.get(bindings(session, rendered.variables)) as { value: Value } | undefined
    return row?.value ?? null
  }

const truthy =
  (session: Session, condition: Ast.Expression): boolean => {
    const rendered = Transpile.scalar(resolveTableVariableExpression(session, condition))
    const statement = session.db.prepare(`SELECT (CASE WHEN ${rendered.sql} THEN 1 ELSE 0 END) AS value`)
    const row = statement.get(bindings(session, rendered.variables)) as { value: Value } | undefined
    return row?.value === 1
  }

/** @returns RAISERROR printf-style template with % substitutions applied. */
const raiserrorFormat =
  (template: string, values: readonly Value[]): string => {
    let index = 0
    return template.replace(/%(%|\d*(?:\.\d+)?[sdiuoxX])/g, (_whole, spec: string) => {
      if (spec === '%') {
        return '%'
      }
      const value = values[index]
      index++
      if (value === null || value === undefined) {
        return '(null)'
      }
      const kind = spec[spec.length - 1] ?? 's'
      if (kind === 's') {
        return String(value)
      }
      const numeric = Math.trunc(Number(value))
      return kind === 'x' ?
        numeric.toString(16) :
        kind === 'X' ? numeric.toString(16).toUpperCase() : String(numeric)
    })
  }

const hasIdentity =
  (session: Session, table: Ast.QualifiedName): boolean => {
    const backing = table[table.length - 1]?.toLowerCase()
    const tableVariable = [ ...session.tableVariables.values() ].find(variable =>
      variable.table[variable.table.length - 1]?.toLowerCase() === backing)
    if (tableVariable !== undefined) {
      return tableVariable.columns.some(column => column.identity !== undefined)
    }
    const objectId = Catalog.objectIdOf(session.db, table)
    return objectId !== undefined &&
      Catalog.tableColumns(session.db, objectId).some(column => column.is_identity === 1)
  }

const decimalType =
  (type: Ast.ColumnDefinition['type']): Ast.ColumnDefinition['type'] | undefined =>
    [ 'decimal', 'numeric', 'dec', 'money', 'smallmoney' ].includes(type.name) ? type : undefined

const decimalShape =
  (type: Ast.ColumnDefinition['type']): readonly [ number, number ] | undefined => {
    if (type.name === 'money') {
      return [ 19, 4 ]
    }
    if (type.name === 'smallmoney') {
      return [ 10, 4 ]
    }
    if (![ 'decimal', 'numeric', 'dec' ].includes(type.name)) {
      return undefined
    }
    return [
      typeof type.args[0] === 'number' ? type.args[0] : 18,
      typeof type.args[1] === 'number' ? type.args[1] : 0
    ]
  }

const decimalArgument =
  (value: Exclude<Value, null>): string | number | bigint =>
    value instanceof Uint8Array ? String(value) : typeof value === 'boolean' ? Number(value) : value

const targetColumns =
  (session: Session, name: Ast.QualifiedName): readonly {
    readonly name: string,
    readonly type?: Ast.ColumnDefinition['type'],
    readonly computed?: boolean
  }[] => {
    const backing = name[name.length - 1]?.toLowerCase()
    const variable = [ ...session.tableVariables.values() ].find(candidate =>
      candidate.table[candidate.table.length - 1]?.toLowerCase() === backing)
    if (variable !== undefined) {
      return variable.columns.map(column => ({
        name: column.name,
        type: column.type,
        ...column.computed === undefined ? {} : { computed: true }
      }))
    }
    const objectId = Catalog.objectIdOf(session.db, name)
    if (objectId === undefined) {
      return []
    }
    return Catalog.tableColumns(session.db, objectId).map(column => {
      const type = column.system_type_id === 106 ? { name: 'decimal', args: [ column.precision, column.scale ] } :
        column.system_type_id === 108 ? { name: 'numeric', args: [ column.precision, column.scale ] } :
          column.system_type_id === 60 ? { name: 'money', args: [] } :
            column.system_type_id === 122 ? { name: 'smallmoney', args: [] } : undefined
      return {
        name: column.name,
        ...type === undefined ? {} : { type },
        ...column.is_computed === 0 ? {} : { computed: true }
      }
    })
  }

const decimalCast =
  (value: Ast.Expression, type: Ast.ColumnDefinition['type']): Ast.Expression =>
    value.kind === 'default' ? value : { kind: 'cast', expression: value, type, try_: false }

/** Applies target-column decimal conversion before SQLite sees DML values. */
const resolveDecimalDml =
  (session: Session, statement: Ast.Statement): Ast.Statement => {
    if (statement.kind === 'insert') {
      const all = targetColumns(session, statement.table)
      const names = statement.columns ?? all.filter(column => column.computed !== true)
        .map(column => column.name)
      const types = names.map(name => decimalType(
        all.find(column => column.name.toLowerCase() === name.toLowerCase())?.type ??
        { name: '', args: [] }))
      if (statement.source.kind === 'values') {
        return {
          ...statement,
          source: {
            ...statement.source,
            rows: statement.source.rows.map(row => row.map((value, index) => {
              const type = types[index]
              return type === undefined ? value : decimalCast(value, type)
            }))
          }
        }
      }
      if (statement.source.kind === 'select') {
        return {
          ...statement,
          source: {
            ...statement.source,
            select: {
              ...statement.source.select,
              items: statement.source.select.items.map((item, index) => {
                const type = types[index]
                return item.kind !== 'expression' || type === undefined ? item :
                  { ...item, expression: decimalCast(item.expression, type) }
              })
            }
          }
        }
      }
      return statement
    }
    if (statement.kind === 'update') {
      const columns = targetColumns(session, statement.target)
      return {
        ...statement,
        set: statement.set.map(assignment => {
          if (assignment.target.kind !== 'column') {
            return assignment
          }
          const name = assignment.target.name[assignment.target.name.length - 1] ?? ''
          const type = decimalType(columns.find(column =>
            column.name.toLowerCase() === name.toLowerCase())?.type ?? { name: '', args: [] })
          if (type === undefined) {
            return assignment
          }
          if (assignment.operator === '=') {
            return { ...assignment, value: decimalCast(assignment.value, type) }
          }
          return {
            ...assignment,
            operator: '=',
            value: decimalCast({
              kind: 'binaryOp',
              operator: assignment.operator.slice(0, -1),
              left: decimalCast(assignment.target, type),
              right: decimalCast(assignment.value, type)
            }, type)
          }
        })
      }
    }
    return statement
  }

const runRendered =
  (session: Session, rendered: Transpile.Rendered, items: Item[]): void => {
    const statement = session.db.prepare(rendered.sql)
    const result = statement.run(bindings(session, rendered.variables))
    session.rowCount = Number(result.changes)
    items.push({ kind: 'count', rowCount: Number(result.changes), ...countVisibility(session) })
  }

type DmlStatement =
  Ast.Statement & { kind: 'insert' | 'update' | 'delete' }

type TransitionRows = {
  readonly inserted: Record<string, Value>[],
  readonly deleted: Record<string, Value>[]
}

const triggersFor =
  (session: Session, statement: DmlStatement): readonly Trigger[] => {
    const target = statement.kind === 'insert' ? statement.table : statement.target
    const key = procedureKey(target)
    return [ ...session.server.triggers.values() ].filter(trigger =>
      procedureKey(trigger.target) === key && trigger.events.includes(statement.kind) &&
      !session.activeTriggers.has(triggerKey(trigger.name)))
  }

const transitionTable =
  (session: Session, target: Ast.QualifiedName, label: 'inserted' | 'deleted'): string => {
    const name = `#__mssqlite_${label}_${session.spid}_${session.nextTransitionTable++}`
    session.db.exec(
      `CREATE TEMP TABLE ${Transpile.Quote.identifier(name)} AS ` +
      `SELECT * FROM ${Transpile.Quote.objectName(target)} WHERE 0`)
    return name
  }

const insertTransitionRows =
  (session: Session, table: string, rows: readonly Record<string, Value>[]): void => {
    const first = rows[0]
    if (first === undefined) {
      return
    }
    const columns = Object.keys(first)
    const sql = `INSERT INTO ${Transpile.Quote.identifier(table)} (` +
      `${columns.map(Transpile.Quote.identifier).join(', ')}) VALUES (` +
      `${columns.map(() => '?').join(', ')})`
    const insert = session.db.prepare(sql)
    for (const row of rows) {
      insert.run(...columns.map(column => bindable(row[column] ?? null)))
    }
  }

const returningRows =
  (session: Session, statement: DmlStatement): Record<string, Value>[] => {
    const qualifier = statement.kind === 'delete' ? 'deleted' : 'inserted'
    const captured: DmlStatement = {
      ...statement,
      output: { items: [ { kind: 'star', qualifier: [ qualifier ] } ] }
    }
    const rendered = Transpile.statement(captured)
    return session.db.prepare(rendered.sql)
      .all(bindings(session, rendered.variables)) as Record<string, Value>[]
  }

const affectedSelect =
  (statement: Ast.Statement & { kind: 'update' | 'delete' }): Ast.Select => ({
    kind: 'select',
    distinct: false,
    ...statement.top === undefined ? {} : { top: { count: statement.top, percent: false } },
    items: [ { kind: 'star' } ],
    from: statement.from ?? { kind: 'table', name: statement.target },
    ...statement.where === undefined ? {} : { where: statement.where }
  })

const selectRecords =
  (session: Session, select: Ast.Select): Record<string, Value>[] => {
    const rendered = Transpile.statement(select)
    return session.db.prepare(rendered.sql)
      .all(bindings(session, rendered.variables)) as Record<string, Value>[]
  }

const insteadOfRows =
  (session: Session, statement: DmlStatement, target: Ast.QualifiedName): TransitionRows => {
    switch (statement.kind) {
      case 'insert': {
        const insertedTable = transitionTable(session, target, 'inserted')
        const inserted = returningRows(session, { ...statement, table: [ insertedTable ] })
        session.db.exec(`DROP TABLE ${Transpile.Quote.identifier(insertedTable)}`)
        return { inserted, deleted: [] }
      }
      case 'delete':
        return { inserted: [], deleted: selectRecords(session, affectedSelect(statement)) }
      case 'update': {
        if (statement.from !== undefined) {
          throw new MssqlError('INSTEAD OF UPDATE with a FROM clause is not supported.', 40000, 16)
        }
        const deleted = selectRecords(session, affectedSelect(statement))
        const insertedTable = transitionTable(session, target, 'inserted')
        insertTransitionRows(session, insertedTable, deleted)
        const inserted = returningRows(session, {
          kind: 'update',
          target: [ insertedTable ],
          set: statement.set
        })
        session.db.exec(`DROP TABLE ${Transpile.Quote.identifier(insertedTable)}`)
        return { inserted, deleted }
      }
      default:
        throw new MssqlError('Statement is not a triggerable DML statement.', 40000, 16)
    }
  }

const afterRows =
  (session: Session, statement: DmlStatement): TransitionRows => {
    if (statement.kind === 'update') {
      if (statement.from !== undefined) {
        throw new MssqlError('Triggered UPDATE with a FROM clause is not supported.', 40000, 16)
      }
      const deleted = selectRecords(session, affectedSelect(statement))
      return { inserted: returningRows(session, statement), deleted }
    }
    const rows = returningRows(session, statement)
    return statement.kind === 'insert' ?
      { inserted: rows, deleted: [] } :
      { inserted: [], deleted: rows }
  }

const runTrigger =
  (
    session: Session,
    trigger: Trigger,
    target: Ast.QualifiedName,
    rows: TransitionRows,
    items: Item[]
  ): void => {
    if (session.nestLevel >= 32) {
      throw new MssqlError(
        'Maximum stored procedure, function, trigger, or view nesting level exceeded (limit 32).', 217, 16)
    }
    const inserted = transitionTable(session, target, 'inserted')
    const deleted = transitionTable(session, target, 'deleted')
    insertTransitionRows(session, inserted, rows.inserted)
    insertTransitionRows(session, deleted, rows.deleted)
    const saved = new Map(session.transitionTables)
    session.transitionTables.set('inserted', { table: [ inserted ], columns: [], constraints: [] })
    session.transitionTables.set('deleted', { table: [ deleted ], columns: [], constraints: [] })
    const key = triggerKey(trigger.name)
    const savedVariables = new Map(session.variables)
    const savedNocount = session.options.get('nocount')
    session.variables.clear()
    session.activeTriggers.add(key)
    session.nestLevel++
    try {
      withCursorScope(session, () => withTableVariableScope(session, () => {
        const triggerItems: Item[] = []
        for (const inner of trigger.body) {
          const signal = executeStatement(session, inner, triggerItems)
          if (signal === 'return') {
            break
          }
        }
        items.push(...triggerItems)
      }))
    } finally {
      if (savedNocount === undefined) {
        session.options.delete('nocount')
      } else {
        session.options.set('nocount', savedNocount)
      }
      session.nestLevel--
      session.activeTriggers.delete(key)
      session.transitionTables.clear()
      for (const [ name, table ] of saved) {
        session.transitionTables.set(name, table)
      }
      session.variables.clear()
      for (const [ name, variable ] of savedVariables) {
        session.variables.set(name, variable)
      }
      session.db.exec(`DROP TABLE IF EXISTS ${Transpile.Quote.identifier(inserted)}`)
      session.db.exec(`DROP TABLE IF EXISTS ${Transpile.Quote.identifier(deleted)}`)
    }
  }

/** Executes one DML statement and its statement-level triggers atomically. */
const runTriggered =
  (session: Session, statement: DmlStatement, triggers: readonly Trigger[], items: Item[]): void => {
    if (statement.output !== undefined) {
      throw new MssqlError('OUTPUT on a statement that fires a trigger is not supported.', 40000, 16)
    }
    const target = statement.kind === 'insert' ? statement.table : statement.target
    const insteadOf = triggers.filter(trigger => trigger.timing === 'insteadOf')
    const after = triggers.filter(trigger => trigger.timing === 'after')
    const savepoint = `__mssqlite_trigger_${session.spid}_${session.nextTransitionTable++}`
    const previousRowCount = session.rowCount
    let failedInTrigger = false
    session.db.exec(`SAVEPOINT ${Transpile.Quote.identifier(savepoint)}`)
    try {
      const rows = insteadOf.length > 0 ?
        insteadOfRows(session, statement, target) :
        afterRows(session, statement)
      const rowCount = statement.kind === 'delete' ? rows.deleted.length : rows.inserted.length
      session.rowCount = rowCount
      for (const trigger of insteadOf.length > 0 ? insteadOf : after) {
        try {
          runTrigger(session, trigger, target, rows, items)
        } catch (error) {
          failedInTrigger = true
          throw error
        }
      }
      session.db.exec(`RELEASE SAVEPOINT ${Transpile.Quote.identifier(savepoint)}`)
      session.rowCount = rowCount
      if (statement.kind === 'insert' && rowCount > 0 && hasIdentity(session, target)) {
        const last = session.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }
        session.lastIdentity = Number(last.id)
      }
      items.push({ kind: 'count', rowCount, ...countVisibility(session) })
    } catch (error) {
      if (failedInTrigger && session.transactionCount > 0) {
        session.db.exec('ROLLBACK')
        session.transactionCount = 0
        session.transactionDoomed = false
      } else if (session.db.isTransaction) {
        session.db.exec(`ROLLBACK TO SAVEPOINT ${Transpile.Quote.identifier(savepoint)}`)
        session.db.exec(`RELEASE SAVEPOINT ${Transpile.Quote.identifier(savepoint)}`)
      }
      session.rowCount = previousRowCount
      throw error
    }
  }

/** Runs a DML statement whose OUTPUT clause renders as SQLite RETURNING. */
const runWithOutput =
  (session: Session, statement: Ast.Statement & { kind: 'insert' | 'update' | 'delete' }, output: Ast.Output, items: Item[]): void => {
    const rendered = Transpile.statement(statement)
    const prepared = session.db.prepare(rendered.sql)
    const records = prepared.all(bindings(session, rendered.variables)) as Record<string, Value>[]
    const columns = columnsOf(session.db, prepared, records, session.tableVariables.values())
    const rows = records.map(record => columns.map(column => record[column.name] ?? null))
    session.rowCount = rows.length
    if (statement.kind === 'insert' && rows.length > 0 && hasIdentity(session, statement.table)) {
      const last = session.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint }
      session.lastIdentity = Number(last.id)
    }
    emitOutput(session, output, { kind: 'rows', columns, rows, rowCount: rows.length }, items)
  }

/**
 * UPDATE with an OUTPUT clause reading DELETED values — SQLite RETURNING only
 * exposes post-update rows, so snapshot the affected rows into a temp table,
 * update exactly those rows, then join the old and new images under the
 * `deleted` / `inserted` aliases the OUTPUT items already use.
 */
const updateWithOutput =
  (session: Session, statement: Ast.Statement & { kind: 'update' }, output: Ast.Output, items: Item[]): void => {
    if (statement.from !== undefined) {
      throw new MssqlError('UPDATE with both a FROM clause and OUTPUT DELETED is not supported.', 40000, 16)
    }
    const snapshot: Ast.Select = {
      kind: 'select',
      distinct: false,
      ...statement.top === undefined ? {} : { top: { count: statement.top, percent: false } },
      items: [
        { kind: 'expression', expression: { kind: 'column', name: [ 'rowid' ] }, alias: '__mssqlite_rowid' },
        { kind: 'star' }
      ],
      from: { kind: 'table', name: statement.target },
      ...statement.where === undefined ? {} : { where: statement.where }
    }
    const captured = Transpile.statement(snapshot)
    session.db.exec('DROP TABLE IF EXISTS temp."__mssqlite_output"')
    session.db.prepare(`CREATE TEMP TABLE "__mssqlite_output" AS ${captured.sql}`)
      .run(bindings(session, captured.variables))
    try {
      const update: Ast.Statement = {
        kind: 'update',
        target: statement.target,
        set: statement.set,
        where: {
          kind: 'in',
          expression: { kind: 'column', name: [ 'rowid' ] },
          values: {
            kind: 'select',
            distinct: false,
            items: [ { kind: 'expression', expression: { kind: 'column', name: [ '__mssqlite_rowid' ] } } ],
            from: { kind: 'table', name: [ '__mssqlite_output' ] }
          },
          negated: false
        }
      }
      const rendered = Transpile.statement(update)
      const changes = session.db.prepare(rendered.sql).run(bindings(session, rendered.variables)).changes
      const outputSelect: Ast.Select = {
        kind: 'select',
        distinct: false,
        items: expandOutputStars(session, statement.target, output.items),
        from: {
          kind: 'join',
          join: 'inner',
          left: { kind: 'table', name: statement.target, alias: 'inserted' },
          right: { kind: 'table', name: [ '__mssqlite_output' ], alias: 'deleted' },
          on: {
            kind: 'binaryOp',
            operator: '=',
            left: { kind: 'column', name: [ 'inserted', 'rowid' ] },
            right: { kind: 'column', name: [ 'deleted', '__mssqlite_rowid' ] }
          }
        }
      }
      const renderedOutput = Transpile.statement(outputSelect)
      emitOutput(session, output, query(session, renderedOutput.sql, renderedOutput.variables), items)
      session.rowCount = Number(changes)
    } finally {
      session.db.exec('DROP TABLE IF EXISTS temp."__mssqlite_output"')
    }
  }

const applyAssign =
  (session: Session, name: string, operator: string, value: Value): void => {
    const key = name.toLowerCase()
    const variable = session.variables.get(key)
    if (variable === undefined) {
      throw new MssqlError(`Must declare the scalar variable "${name}".`, 137, 15)
    }
    const shape = decimalShape(variable.type)
    const decimalValue = (input: Value): string | null => input === null ? null :
      DecimalExact.cast(
        decimalArgument(input), shape?.[0] ?? 18, shape?.[1] ?? 0, false)
    if (operator === '=') {
      variable.value = shape === undefined ? value : decimalValue(value)
    } else {
      const current = variable.value
      if (current === null || value === null) {
        variable.value = null
      } else if (shape !== undefined) {
        const right = decimalValue(value)
        variable.value = DecimalExact.arithmetic(
          operator.slice(0, -1), decimalValue(current), right,
          shape[1], shape[1], shape[0], shape[1])
      } else if (operator === '+=' && (typeof current === 'string' || typeof value === 'string')) {
        variable.value = String(current) + String(value)
      } else {
        const a = Number(current)
        const b = Number(value)
        switch (operator) {
          case '+=':
            variable.value = a + b
            break
          case '-=':
            variable.value = a - b
            break
          case '*=':
            variable.value = a * b
            break
          case '/=':
            variable.value = a / b
            break
          case '%=':
            variable.value = a % b
            break
          default:
            throw new MssqlError(`Unsupported assignment operator ${operator}.`, 102, 15)
        }
      }
    }
  }

/** SELECT that assigns variables (`SELECT @x = ...`) — returns no result set. */
const selectAssign =
  (session: Session, statement: Ast.Select): void => {
    // Alias every item to a unique synthetic name so two assignments reading
    // the same column don't collapse to one key in the result record.
    const items = statement.items.map((item, index): Ast.SelectItem =>
      item.kind === 'assign' ?
        { kind: 'expression', expression: item.expression, alias: `__assign_${index}` } :
        item)
    const rendered = Transpile.statement({ ...statement, items } as Ast.Statement)
    const prepared = session.db.prepare(rendered.sql)
    const records = prepared.all(bindings(session, rendered.variables)) as Record<string, Value>[]
    session.rowCount = records.length
    const last = records[records.length - 1]
    if (last === undefined) {
      return
    }
    statement.items.forEach((item, index) => {
      if (item.kind === 'assign') {
        applyAssign(session, item.variable, item.operator, last[`__assign_${index}`] ?? null)
      }
    })
  }

const selectInto =
  (session: Session, statement: Ast.Select, items: Item[]): void => {
    const into = statement.into
    if (into === undefined) {
      return
    }
    const { into: _into, ...rest } = statement
    const select = Transpile.statement(rest as Ast.Statement)
    const table = Transpile.Quote.objectName(into)
    const create = `CREATE TABLE ${table} AS ${select.sql}`
    session.db.prepare(create).run(bindings(session, select.variables))
    const columns = session.db.prepare(`PRAGMA table_info(${table})`).all() as
      { name: string, type: string }[]
    Catalog.createTable(session.db, {
      kind: 'createTable',
      name: into,
      columns: columns.map(column => ({
        name: column.name,
        type: {
          name: column.type.toUpperCase().includes('INT') ?
            'int' :
            column.type.toUpperCase().includes('REAL') ? 'float' : 'nvarchar',
          args: []
        }
      })),
      constraints: []
    })
    const count = session.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    session.rowCount = count.n
    items.push({ kind: 'count', rowCount: count.n, ...countVisibility(session) })
  }

const cursorOf =
  (session: Session, name: string): Cursor => {
    const cursor = session.cursors.get(name.toLowerCase())
    if (cursor === undefined) {
      throw new MssqlError(`A cursor with the name '${name}' does not exist.`, 16916, 16)
    }
    return cursor
  }

const declareCursor =
  (session: Session, statement: Ast.Statement & { kind: 'declareCursor' }): void => {
    const key = statement.name.toLowerCase()
    if (session.cursors.has(key)) {
      throw new MssqlError(`A cursor with the name '${statement.name}' already exists.`, 16915, 16)
    }
    if (statement.select.into !== undefined ||
      statement.select.items.some(item => item.kind === 'assign')) {
      throw new MssqlError('Cursor SELECT statements cannot assign variables or use INTO.', 16907, 16)
    }
    session.cursors.set(key, {
      name: statement.name,
      scope: statement.scope,
      options: statement.options,
      select: statement.select,
      ...statement.updateColumns === undefined ? {} : { updateColumns: statement.updateColumns },
      state: 'declared',
      columns: [],
      rows: [],
      position: -1
    })
  }

const openCursor =
  (session: Session, name: string): void => {
    const cursor = cursorOf(session, name)
    if (cursor.state === 'open') {
      throw new MssqlError('The cursor is already open.', 16905, 16)
    }
    const resolved = resolveTableVariables(session, cursor.select)
    if (resolved.kind !== 'select') {
      throw new MssqlError('Cursor query is not a SELECT statement.', 16907, 16)
    }
    const rendered = Transpile.statement(resolved)
    const hints = rendered.columns ?? userFunctionHints(session, resolved) ?? []
    const result = query(session, rendered.sql, rendered.variables, hints)
    cursor.columns = result.columns
    cursor.rows = result.rows
    cursor.position = -1
    cursor.state = 'open'
    session.rowCount = result.rowCount
  }

const fetchPosition =
  (session: Session, cursor: Cursor, orientation: Ast.FetchOrientation): number => {
    switch (orientation.kind) {
      case 'next':
        return cursor.position + 1
      case 'prior':
        return cursor.position - 1
      case 'first':
        return 0
      case 'last':
        return cursor.rows.length - 1
      case 'absolute': {
        const offset = Math.trunc(Number(evaluate(session, orientation.offset)))
        return offset > 0 ? offset - 1 : offset < 0 ? cursor.rows.length + offset : -1
      }
      case 'relative':
        return cursor.position + Math.trunc(Number(evaluate(session, orientation.offset)))
      default:
        throw new MssqlError('Unsupported cursor fetch orientation.', 16907, 16)
    }
  }

const assertFetchOrientation =
  (cursor: Cursor, orientation: Ast.FetchOrientation): void => {
    const forwardOnly = cursor.options.includes('forward_only') ||
      cursor.options.includes('fast_forward') ||
      !cursor.options.some(option =>
        option === 'scroll' || option === 'static' || option === 'keyset' || option === 'dynamic')
    if (forwardOnly && orientation.kind !== 'next') {
      throw new MssqlError(
        `FETCH: The fetch type ${orientation.kind.toUpperCase()} cannot be used with forward only cursors.`,
        16911, 16)
    }
    if (cursor.options.includes('dynamic') && orientation.kind === 'absolute') {
      throw new MssqlError(
        'The fetch type ABSOLUTE cannot be used with dynamic cursors.', 16925, 16)
    }
  }

const fetchCursor =
  (session: Session, statement: Ast.Statement & { kind: 'fetchCursor' }, items: Item[]): void => {
    const cursor = cursorOf(session, statement.name)
    if (cursor.state !== 'open') {
      throw new MssqlError('Cursor is not open.', 16917, 16)
    }
    assertFetchOrientation(cursor, statement.orientation)
    if (statement.into.length > 0 && statement.into.length !== cursor.columns.length) {
      throw new MssqlError(
        'Cursorfetch: The number of variables declared in the INTO list must match that of selected columns.',
        16924, 16)
    }
    for (const name of statement.into) {
      if (!session.variables.has(name.toLowerCase())) {
        throw new MssqlError(`Must declare the scalar variable "${name}".`, 137, 15)
      }
    }
    const position = fetchPosition(session, cursor, statement.orientation)
    const row = cursor.rows[position]
    cursor.position = position < 0 ? -1 : position >= cursor.rows.length ? cursor.rows.length : position
    if (row === undefined) {
      session.fetchStatus = -1
      session.rowCount = 0
      if (statement.into.length === 0) {
        items.push({
          kind: 'rows', columns: cursor.columns, rows: [], rowCount: 0,
          ...countVisibility(session)
        })
      }
      return
    }
    session.fetchStatus = 0
    session.rowCount = 1
    if (statement.into.length === 0) {
      items.push({
        kind: 'rows', columns: cursor.columns, rows: [ row ], rowCount: 1,
        ...countVisibility(session)
      })
      return
    }
    statement.into.forEach((name, index) => applyAssign(session, name, '=', row[index] ?? null))
  }

const closeCursor =
  (session: Session, name: string): void => {
    const cursor = cursorOf(session, name)
    if (cursor.state !== 'open') {
      throw new MssqlError('Cursor is not open.', 16917, 16)
    }
    cursor.state = 'closed'
    cursor.columns = []
    cursor.rows = []
    cursor.position = -1
  }

type TransactionStatement =
  Ast.Statement & {
    kind: 'beginTransaction' | 'commitTransaction' | 'rollbackTransaction' | 'saveTransaction'
  }

const executeTransaction =
  (session: Session, statement: TransactionStatement): void => {
    switch (statement.kind) {
      case 'beginTransaction':
        if (session.transactionCount === 0) {
          session.db.exec('BEGIN')
          session.transactionDoomed = false
        }
        session.transactionCount++
        return
      case 'commitTransaction':
        if (session.transactionCount === 0) {
          throw new MssqlError('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.', 3902, 16)
        }
        if (session.transactionDoomed) {
          throw new MssqlError(
            'The current transaction cannot be committed and cannot support operations that write to the log file. Roll back the transaction.',
            3930, 16)
        }
        if (session.transactionCount === 1) {
          session.db.exec('COMMIT')
        }
        session.transactionCount--
        return
      case 'rollbackTransaction':
        if (statement.name !== undefined && !statement.name.startsWith('@')) {
          // Named rollback targets a savepoint when one exists.
          try {
            session.db.exec(`ROLLBACK TO SAVEPOINT "${statement.name.replaceAll('"', '""')}"`)
            return
          } catch {
            // Fall through to a full rollback of the named transaction.
          }
        }
        if (session.transactionCount > 0) {
          session.db.exec('ROLLBACK')
          session.transactionCount = 0
        }
        session.transactionDoomed = false
        return
      case 'saveTransaction':
        // A bare SAVEPOINT implicitly opens a SQLite transaction; keep
        // @@TRANCOUNT in step so a later BEGIN TRAN doesn't hit "cannot start a
        // transaction within a transaction" and the work isn't left untracked.
        if (session.transactionCount === 0) {
          session.db.exec('BEGIN')
          session.transactionCount = 1
        }
        session.db.exec(`SAVEPOINT "${statement.name.replaceAll('"', '""')}"`)
        return
      default:
        return
    }
  }

const executeStatementInner =
  (session: Session, statement_: Ast.Statement, items: Item[]): Signal => {
    const transitionTarget = statement_.kind === 'insert' ? statement_.table :
      statement_.kind === 'update' || statement_.kind === 'delete' ? statement_.target :
        undefined
    if (transitionTarget?.length === 1 &&
      session.transitionTables.has(transitionTarget[0]?.toLowerCase() ?? '')) {
      throw new MssqlError(
        `The logical table '${transitionTarget[0]}' cannot be updated.`, 286, 16)
    }
    const statement = resolveDecimalDml(session, resolveTableVariables(session, statement_))
    if (statement.kind === 'createFunction') {
      defineFunction(session, statement)
      return undefined
    }
    if (statement.kind === 'dropFunction') {
      for (const name of statement.names) {
        const key = functionKey(name)
        if (!session.server.functions.has(key)) {
          if (!statement.ifExists) {
            throw new MssqlError(
              `Cannot drop the function '${name.join('.')}', because it does not exist or you do not have permission.`,
              3701, 16)
          }
          continue
        }
        Catalog.dropFunction(session.db, name)
        session.server.functions.delete(key)
      }
      return undefined
    }
    if (statement.kind === 'createTrigger') {
      defineTrigger(session, statement)
      return undefined
    }
    if (statement.kind === 'dropTrigger') {
      for (const name of statement.names) {
        const key = triggerKey(name)
        if (!session.server.triggers.has(key)) {
          if (!statement.ifExists) {
            throw new MssqlError(
              `Cannot drop the trigger '${name.join('.')}', because it does not exist or you do not have permission.`,
              3701, 16)
          }
          continue
        }
        Catalog.dropTrigger(session.db, name)
        session.server.triggers.delete(key)
      }
      return undefined
    }
    if (statement.kind === 'declareCursor') {
      declareCursor(session, statement)
      return undefined
    }
    if (statement.kind === 'openCursor') {
      openCursor(session, statement.name)
      return undefined
    }
    if (statement.kind === 'fetchCursor') {
      fetchCursor(session, statement, items)
      return undefined
    }
    if (statement.kind === 'closeCursor') {
      closeCursor(session, statement.name)
      return undefined
    }
    if (statement.kind === 'deallocateCursor') {
      const cursor = cursorOf(session, statement.name)
      session.cursors.delete(cursor.name.toLowerCase())
      return undefined
    }
    if (statement.kind === 'createSequence') {
      defineSequence(session, statement)
      return undefined
    }
    if (statement.kind === 'alterSequence') {
      redefineSequence(session, statement)
      return undefined
    }
    if (statement.kind === 'dropSequence') {
      for (const name of statement.names) {
        removeSequence(session, name, statement.ifExists)
      }
      return undefined
    }
    switch (statement.kind) {
      case 'select': {
        if (statement.into !== undefined) {
          selectInto(session, statement, items)
          return undefined
        }
        if (statement.items.some(item => item.kind === 'assign')) {
          selectAssign(session, statement)
          return undefined
        }
        const rendered = Transpile.statement(statement)
        const hints = rendered.columns ?? userFunctionHints(session, statement) ?? []
        items.push(query(session, rendered.sql, rendered.variables, hints))
        return undefined
      }
      case 'insert': {
        const triggers = triggersFor(session, statement)
        if (triggers.length > 0) {
          runTriggered(session, statement, triggers, items)
          return undefined
        }
        if (statement.output !== undefined) {
          runWithOutput(session, statement, statement.output, items)
          return undefined
        }
        const rendered = Transpile.statement(statement)
        const prepared = session.db.prepare(rendered.sql)
        const result = prepared.run(bindings(session, rendered.variables))
        session.rowCount = Number(result.changes)
        // Only a row actually inserted into an identity table advances
        // @@IDENTITY / SCOPE_IDENTITY; a zero-row insert leaves them unchanged
        // (last_insert_rowid is connection-global and would otherwise leak a
        // stale id from an unrelated table).
        if (result.changes > 0 && hasIdentity(session, statement.table)) {
          session.lastIdentity = Number(result.lastInsertRowid)
        }
        items.push({
          kind: 'count', rowCount: Number(result.changes), ...countVisibility(session)
        })
        return undefined
      }
      case 'merge':
        executeMerge(session, statement, items)
        return undefined
      case 'update':
      case 'delete': {
        const triggers = triggersFor(session, statement)
        if (triggers.length > 0) {
          runTriggered(session, statement, triggers, items)
          return undefined
        }
        if (statement.output !== undefined) {
          if (statement.kind === 'update' && Transpile.Output.readsDeleted(statement.output)) {
            updateWithOutput(session, statement, statement.output, items)
          } else {
            runWithOutput(session, statement, statement.output, items)
          }
          return undefined
        }
        runRendered(session, Transpile.statement(statement), items)
        return undefined
      }
      case 'truncate': {
        runRendered(session, Transpile.statement(statement), items)
        const name = Catalog.objectNameOf(statement.table).name
        try {
          session.db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name)
        } catch {
          // No AUTOINCREMENT table exists yet — nothing to reset.
        }
        return undefined
      }
      case 'createTable': {
        const resolved = { ...statement, columns: Transpile.Computed.columns(statement.columns) }
        const rendered = Transpile.statement(resolved)
        session.db.exec(rendered.sql)
        Catalog.createTable(session.db, resolved)
        return undefined
      }
      case 'dropTable':
        session.db.exec(Transpile.statement(statement).sql)
        for (const name of statement.names) {
          const target = procedureKey(name)
          for (const [ key, trigger ] of session.server.triggers) {
            if (procedureKey(trigger.target) === target) {
              session.server.triggers.delete(key)
            }
          }
          Catalog.dropTable(session.db, name)
        }
        return undefined
      case 'createIndex':
        {
          const objectId = Catalog.objectIdOf(session.db, statement.table)
          const collations = objectId === undefined ? [] : Catalog.tableColumns(session.db, objectId)
          const resolved = {
            ...statement,
            columns: statement.columns.map(column => {
              const collation = collations.find(candidate =>
                candidate.name.toLowerCase() === column.name.toLowerCase())?.collation_name
              return { ...column, ...collation === null || collation === undefined ? {} : { collation } }
            })
          }
          session.db.exec(Transpile.statement(resolved).sql)
          Catalog.createIndex(session.db, resolved)
        }
        return undefined
      case 'dropIndex':
        session.db.exec(Transpile.statement(statement).sql)
        Catalog.dropIndex(session.db, statement.name)
        return undefined
      case 'createView':
        session.db.exec(Transpile.statement(statement).sql)
        Catalog.createView(session.db, statement.name)
        return undefined
      case 'dropView':
        session.db.exec(Transpile.statement(statement).sql)
        for (const name of statement.names) {
          Catalog.dropView(session.db, name)
        }
        return undefined
      case 'alterTable': {
        const resolved = statement.action.kind === 'addColumns' ? {
          ...statement,
          action: {
            ...statement.action,
            columns: Transpile.Computed.columns(
              statement.action.columns, columnsOfTable(session, statement.name))
          }
        } : statement
        session.db.exec(Transpile.statement(resolved).sql)
        switch (resolved.action.kind) {
          case 'addColumns':
            Catalog.addColumns(session.db, resolved.name, resolved.action.columns)
            break
          case 'dropColumns':
            Catalog.dropColumns(session.db, resolved.name, resolved.action.columns)
            break
          default:
            break
        }
        return undefined
      }
      case 'declare':
        for (const declaration of statement.declarations) {
          if (declaration.kind === 'table') {
            declareTableVariable(session, declaration)
            continue
          }
          if (session.tableVariables.has(declaration.name.toLowerCase())) {
            throw new MssqlError(
              `The variable name '${declaration.name}' has already been declared. Variable names must be unique within a query batch or stored procedure.`,
              134, 15)
          }
          const value = declaration.initial === undefined ?
            null :
            evaluate(session, declaration.initial)
          session.variables.set(declaration.name.toLowerCase(), {
            type: declaration.type,
            value: decimalShape(declaration.type) === undefined ? value :
              value === null ? null : DecimalExact.cast(
                decimalArgument(value),
                decimalShape(declaration.type)?.[0] ?? 18,
                decimalShape(declaration.type)?.[1] ?? 0,
                false)
          } as Variable)
        }
        return undefined
      case 'setVariable':
        applyAssign(session, statement.name, statement.operator, evaluate(session, statement.value))
        return undefined
      case 'setOption':
        for (const option of statement.options) {
          session.options.set(option, statement.value)
        }
        return undefined
      case 'if':
        return truthy(session, statement.condition) ?
          executeStatement(session, statement.then, items) :
          statement.else_ === undefined ?
            undefined :
            executeStatement(session, statement.else_, items)
      case 'while':
        for (;;) {
          if (!truthy(session, statement.condition)) {
            return undefined
          }
          const signal = executeStatement(session, statement.body, items)
          if (signal === 'break') {
            return undefined
          }
          if (signal === 'return') {
            return 'return'
          }
        }
      case 'block':
        for (const inner of statement.statements) {
          const signal = executeStatement(session, inner, items)
          if (signal !== undefined) {
            return signal
          }
        }
        return undefined
      case 'break':
      case 'continue':
        return statement.kind
      case 'return':
        if (statement.expression !== undefined) {
          session.returnValue = evaluate(session, statement.expression)
        }
        return 'return'
      case 'createProcedure':
        defineProcedure(session, statement)
        return undefined
      case 'dropProcedure':
        for (const name of statement.names) {
          const key = procedureKey(name)
          if (!session.server.procedures.has(key)) {
            if (!statement.ifExists) {
              throw new MssqlError(
                `Cannot drop the procedure '${name.join('.')}', because it does not exist or you do not have permission.`,
                3701, 16)
            }
            continue
          }
          Catalog.dropProcedure(session.db, name)
          session.server.procedures.delete(key)
        }
        return undefined
      case 'beginTransaction':
      case 'commitTransaction':
      case 'rollbackTransaction':
      case 'saveTransaction':
        executeTransaction(session, statement)
        return undefined
      case 'use':
        session.database = statement.database
        return undefined
      case 'print':
        items.push({ kind: 'message', text: String(evaluate(session, statement.expression) ?? '') })
        return undefined
      case 'throw': {
        if (statement.number === undefined) {
          // Bare THROW re-raises the error being handled by the enclosing CATCH.
          const caught = session.caughtError
          if (caught === undefined) {
            throw new MssqlError(
              'To rethrow an error, a THROW statement must be used inside a CATCH block.', 10704, 15)
          }
          throw new MssqlError(caught.message, caught.number, caught.severity, caught.state)
        }
        const number = Number(evaluate(session, statement.number))
        const message = statement.message === undefined ?
          'An error was raised.' :
          String(evaluate(session, statement.message) ?? '')
        const state = statement.state === undefined ? 1 : Number(evaluate(session, statement.state))
        throw new MssqlError(message, number, 16, state)
      }
      case 'raiserror': {
        const [ first, severityArg, stateArg, ...rest ] = statement.args
        if (first === undefined || severityArg === undefined || stateArg === undefined) {
          throw new MssqlError('RAISERROR requires a message, a severity and a state.', 102, 15)
        }
        const value = evaluate(session, first)
        const severity = Number(evaluate(session, severityArg))
        const state = Number(evaluate(session, stateArg))
        const substitutions = rest.map(argument => evaluate(session, argument))
        const number = typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 50000
        const template = typeof value === 'string' ?
          value :
          `Error ${number}, severity ${severity}, state ${state} was raised.`
        const text = raiserrorFormat(template, substitutions)
        // Severity 10 and below is informational — printed, not thrown.
        if (severity <= 10) {
          items.push({ kind: 'message', text })
          return undefined
        }
        throw new MssqlError(text, number, severity, state, {
          statementTerminating: true,
          // SQL Server RAISERROR does not honor SET XACT_ABORT.
          honorsXactAbort: false
        })
      }
      case 'tryCatch': {
        try {
          for (const inner of statement.try_) {
            const signal = executeStatement(session, inner, items)
            if (signal !== undefined) {
              return signal
            }
          }
        } catch (error) {
          const mapped = errorOf(error)
          // Severity 20+ ends the connection in MSSQL — not catchable.
          if (mapped.severity > 19) {
            throw mapped
          }
          session.lastError = mapped.number
          if (session.transactionCount > 0 && session.options.get('xact_abort') === 'on') {
            session.transactionDoomed = true
          }
          const previous = session.caughtError
          session.caughtError = {
            number: mapped.number,
            severity: mapped.severity,
            state: mapped.state,
            message: mapped.message,
            procedure: null,
            line: 1
          }
          try {
            for (const inner of statement.catch_) {
              const signal = executeStatement(session, inner, items)
              if (signal !== undefined) {
                return signal
              }
            }
          } finally {
            session.caughtError = previous
          }
        }
        return undefined
      }
      case 'execute':
        return executeProcedure(session, statement, items)
      case 'empty':
        return undefined
      default:
        throw new MssqlError('Statement is not supported.', 40000, 16)
    }
  }

const executeStatement =
  (session: Session, statement: Ast.Statement, items: Item[]): Signal => {
    try {
      return executeStatementInner(session, statement, items)
    } finally {
      flushSequences(session.server)
    }
  }

/** @returns ordered `@name` parameter names from an sp_executesql declaration string. */
const declaredParameterNames =
  (declarations: string): string[] => {
    const names: string[] = []
    let depth = 0
    let segment = ''
    for (const char of declarations) {
      if (char === '(') {
        depth++
      } else if (char === ')') {
        depth--
      }
      if (char === ',' && depth === 0) {
        names.push(segment)
        segment = ''
      } else {
        segment += char
      }
    }
    names.push(segment)
    return names.map(part => /@\w+/.exec(part)?.[0] ?? '').filter(part => part !== '')
  }

const defineProcedure =
  (session: Session, statement: Ast.Statement & { kind: 'createProcedure' }): void => {
    const key = procedureKey(statement.name)
    const name = statement.name[statement.name.length - 1] ?? ''
    const exists = session.server.procedures.has(key)
    if (statement.action === 'create' && exists) {
      throw new MssqlError(`There is already an object named '${name}' in the database.`, 2714, 16)
    }
    if (statement.action === 'alter' && !exists) {
      throw new MssqlError(`Invalid object name '${name}'.`, 208, 16)
    }
    if (exists) {
      Catalog.dropProcedure(session.db, statement.name)
    }
    Catalog.createProcedure(session.db, statement.name, statement.definition)
    session.server.procedures.set(key, {
      name,
      parameters: statement.parameters,
      body: statement.body,
      definition: statement.definition
    })
  }

const defineTrigger =
  (session: Session, statement: Ast.Statement & { kind: 'createTrigger' }): void => {
    const key = triggerKey(statement.name)
    const name = statement.name[statement.name.length - 1] ?? ''
    const exists = session.server.triggers.has(key)
    const objectExists = Catalog.objectIdOf(session.db, statement.name) !== undefined
    if ((statement.action === 'create' && objectExists) ||
      (statement.action === 'createOrAlter' && objectExists && !exists)) {
      throw new MssqlError(`There is already an object named '${name}' in the database.`, 2714, 16)
    }
    if (statement.action === 'alter' && !exists) {
      throw new MssqlError(`Invalid object name '${name}'.`, 208, 16)
    }
    if (Catalog.objectIdOf(session.db, statement.target) === undefined) {
      throw new MssqlError(`Invalid object name '${statement.target.join('.')}'.`, 208, 16)
    }
    if (statement.timing === 'insteadOf') {
      const target = procedureKey(statement.target)
      const collision = [ ...session.server.triggers.entries() ].some(([ otherKey, trigger ]) =>
        otherKey !== key && trigger.timing === 'insteadOf' &&
        procedureKey(trigger.target) === target &&
        trigger.events.some(event => statement.events.includes(event)))
      if (collision) {
        throw new MssqlError(
          'Only one INSTEAD OF trigger is allowed for each INSERT, UPDATE, or DELETE statement on a table.',
          2111, 16)
      }
    }
    if (exists) {
      Catalog.dropTrigger(session.db, statement.name)
    }
    Catalog.createTrigger(session.db, statement.name, statement.target, statement.definition)
    session.server.triggers.set(key, {
      name: statement.name,
      target: statement.target,
      timing: statement.timing,
      events: statement.events,
      options: statement.options,
      body: statement.body,
      definition: statement.definition
    })
  }

const userFunctionHints =
  (session: Session, select: Ast.Select): readonly Transpile.ColumnHint[] | undefined => {
    const hints: Transpile.ColumnHint[] = []
    for (const item of select.items) {
      if (item.kind !== 'expression' || item.expression.kind !== 'call') {
        return undefined
      }
      const function_ = session.server.functions.get(functionKey(item.expression.name))
      if (function_?.returns.kind !== 'scalar') {
        return undefined
      }
      hints.push({
        name: item.alias ?? (item.expression.name[item.expression.name.length - 1] ?? ''),
        type: function_.returns.type,
        nullable: true
      })
    }
    return hints
  }

const validateFunctionStatement =
  (statement: Ast.Statement): void => {
    switch (statement.kind) {
      case 'declare':
        if (statement.declarations.some(declaration => declaration.kind === 'table')) {
          throw new MssqlError('Invalid use of a side-effecting operator within a function.', 443, 16)
        }
        return
      case 'setVariable':
      case 'return':
      case 'break':
      case 'continue':
        return
      case 'select':
        if (statement.items.every(item => item.kind === 'assign')) {
          return
        }
        break
      case 'if':
        validateFunctionStatement(statement.then)
        if (statement.else_ !== undefined) {
          validateFunctionStatement(statement.else_)
        }
        return
      case 'while':
        validateFunctionStatement(statement.body)
        return
      case 'block':
        statement.statements.forEach(validateFunctionStatement)
        return
      default:
        break
    }
    throw new MssqlError('Invalid use of a side-effecting operator within a function.', 443, 16)
  }

const sqliteFunctionName =
  (function_: UserFunction): string =>
    (function_.name[function_.name.length - 1] ?? '').toLowerCase()

const missingFunctionParameter =
  (functionName: string, parameterName: string): never => {
    throw new MssqlError(
      `Function '${functionName}' expects parameter '${parameterName}', which was not supplied.`,
      201, 16)
  }

const invokeScalarFunction =
  (session: Session, key: string, args: readonly Value[]): Value => {
    const function_ = session.server.functions.get(key)
    if (function_ === undefined || function_.returns.kind !== 'scalar') {
      throw new MssqlError(`Could not find scalar function '${key}'.`, 195, 15)
    }
    if (session.nestLevel >= 32) {
      throw new MssqlError(
        'Maximum stored procedure, function, trigger, or view nesting level exceeded (limit 32).', 217, 16)
    }
    if (args.length > function_.parameters.length) {
      throw new MssqlError(`Function ${key} has too many arguments specified.`, 8144, 16)
    }
    const saved = new Map(session.variables)
    const savedReturn = session.returnValue
    session.variables.clear()
    session.nestLevel++
    try {
      function_.parameters.forEach((parameter, index) => {
        const value = index < args.length ?
          args[index] ?? null :
          parameter.default_ === undefined ?
            missingFunctionParameter(key, parameter.name) :
            evaluate(session, parameter.default_)
        session.variables.set(parameter.name.toLowerCase(), { type: parameter.type, value })
      })
      session.returnValue = null
      const items: Item[] = []
      for (const inner of function_.returns.body) {
        const signal = executeStatement(session, inner, items)
        if (signal === 'return') {
          break
        }
      }
      if (items.length > 0) {
        throw new MssqlError('Invalid use of a side-effecting operator within a function.', 443, 16)
      }
      return session.returnValue
    } finally {
      session.nestLevel--
      session.returnValue = savedReturn
      session.variables.clear()
      for (const [ name, variable ] of saved) {
        session.variables.set(name, variable)
      }
    }
  }

const installScalarFunction =
  (server: Server, key: string, function_: UserFunction): void => {
    if (function_.returns.kind !== 'scalar') {
      return
    }
    const name = sqliteFunctionName(function_)
    if (server.registeredFunctions.has(name)) {
      return
    }
    server.db.function(name, { deterministic: false, varargs: true }, (...args) => {
      const current = server.current
      if (current === undefined) {
        throw new Error(`No active session for function ${name}.`)
      }
      const value = invokeScalarFunction(current, key, args as Value[])
      return typeof value === 'boolean' ? Number(value) : value
    })
    server.registeredFunctions.add(name)
  }

const defineFunction =
  (session: Session, statement: Ast.Statement & { kind: 'createFunction' }): void => {
    const key = functionKey(statement.name)
    const name = statement.name[statement.name.length - 1] ?? ''
    const exists = session.server.functions.has(key)
    const objectExists = Catalog.objectIdOf(session.db, statement.name) !== undefined
    if ((statement.action === 'create' || statement.action === 'createOrAlter') &&
      objectExists && !exists) {
      throw new MssqlError(`There is already an object named '${name}' in the database.`, 2714, 16)
    }
    if (statement.action === 'alter' && !exists) {
      throw new MssqlError(`Invalid object name '${name}'.`, 208, 16)
    }
    if (exists) {
      Catalog.dropFunction(session.db, statement.name)
    }
    if (statement.returns.kind === 'scalar') {
      statement.returns.body.forEach(validateFunctionStatement)
    }
    Catalog.createFunction(
      session.db, statement.name, statement.definition, statement.returns.kind === 'table')
    const function_: UserFunction = {
      name: statement.name,
      parameters: statement.parameters,
      returns: statement.returns,
      definition: statement.definition
    }
    session.server.functions.set(key, function_)
    installScalarFunction(session.server, key, function_)
  }

const callUserProcedure =
  (session: Session, procedure: Procedure, statement: Ast.Statement & { kind: 'execute' }, items: Item[]): void => {
    if (session.nestLevel >= 32) {
      throw new MssqlError(
        'Maximum stored procedure, function, trigger, or view nesting level exceeded (limit 32).', 217, 16)
    }
    const byName = new Map(procedure.parameters.map(parameter =>
      [ parameter.name.toLowerCase(), parameter ]))
    // Arguments evaluate in the caller's scope before the parameter scope swaps in.
    const supplied = new Map<string, Value>()
    const outputTargets = new Map<string, string>()
    statement.args.forEach((argument, index) => {
      const parameter = argument.name !== undefined ?
        byName.get(argument.name.toLowerCase()) :
        procedure.parameters[index]
      if (parameter === undefined) {
        throw argument.name !== undefined ?
          new MssqlError(`${argument.name} is not a parameter for procedure ${procedure.name}.`, 8145, 16) :
          new MssqlError(`Procedure or function ${procedure.name} has too many arguments specified.`, 8144, 16)
      }
      const key = parameter.name.toLowerCase()
      if (argument.value.kind !== 'default') {
        supplied.set(key, evaluate(session, argument.value))
      }
      if (argument.output && argument.value.kind === 'variable') {
        outputTargets.set(key, argument.value.name)
      }
    })
    const scope = new Map<string, Variable>()
    for (const parameter of procedure.parameters) {
      const key = parameter.name.toLowerCase()
      let value: Value
      if (supplied.has(key)) {
        value = supplied.get(key) ?? null
      } else if (parameter.default_ !== undefined) {
        value = evaluate(session, parameter.default_)
      } else {
        throw new MssqlError(
          `Procedure or function '${procedure.name}' expects parameter '${parameter.name}', which was not supplied.`,
          201, 16)
      }
      scope.set(key, { type: parameter.type, value } as Variable)
    }
    // The variables map reference is shared session state — swap contents
    // rather than the reference, restoring the caller's scope afterwards.
    const saved = new Map(session.variables)
    const savedReturn = session.returnValue
    const savedNocount = session.options.get('nocount')
    session.variables.clear()
    for (const [ key, variable ] of scope) {
      session.variables.set(key, variable)
    }
    session.returnValue = null
    session.nestLevel++
    const outputs = new Map<string, Value>()
    let status: Value = null
    try {
      withCursorScope(session, () => withTableVariableScope(session, () => {
        for (const inner of procedure.body) {
          const signal = executeStatement(session, inner, items)
          if (signal === 'return') {
            break
          }
        }
      }))
      status = session.returnValue
      for (const key of outputTargets.keys()) {
        outputs.set(key, session.variables.get(key)?.value ?? null)
      }
    } finally {
      if (savedNocount === undefined) {
        session.options.delete('nocount')
      } else {
        session.options.set('nocount', savedNocount)
      }
      session.nestLevel--
      session.returnValue = savedReturn
      session.variables.clear()
      for (const [ key, variable ] of saved) {
        session.variables.set(key, variable)
      }
    }
    // OUTPUT parameters copy back into the caller's variables.
    for (const [ key, target ] of outputTargets) {
      applyAssign(session, target, '=', outputs.get(key) ?? null)
    }
    const numericStatus = typeof status === 'number' || typeof status === 'bigint' ? Number(status) : 0
    session.lastReturnStatus = numericStatus
    if (statement.result !== undefined) {
      applyAssign(session, statement.result, '=', numericStatus)
    }
  }

const executeProcedure =
  (session: Session, statement: Ast.Statement & { kind: 'execute' }, items: Item[]): Signal => {
    const name = (statement.procedure[statement.procedure.length - 1] ?? '').toLowerCase()
    if (name === 'sp_executesql') {
      const [ sql, declarations, ...values ] = statement.args
      if (sql === undefined) {
        throw new MssqlError('sp_executesql expects a statement.', 214, 16)
      }
      const text = evaluate(session, sql.value)
      if (typeof text !== 'string') {
        throw new MssqlError('sp_executesql expects an nvarchar statement.', 214, 16)
      }
      // Positional args bind to the names declared in the @params string, not
      // synthetic @p1/@p2 — MSSQL matches them by declaration order.
      const declared = declarations === undefined ?
        [] :
        declaredParameterNames(String(evaluate(session, declarations.value) ?? ''))
      const parameters: Parameter[] = values.map((argument, index) => ({
        name: argument.name ?? declared[index] ?? `@p${index + 1}`,
        value: evaluate(session, argument.value),
        output: argument.output
      }))
      const nested = executeSql(session, text, parameters)
      items.push(...nested.items)
      // Copy OUTPUT results back into the caller's variables.
      values.forEach((argument, index) => {
        const parameter = parameters[index]
        if (argument.output && argument.value.kind === 'variable' && parameter !== undefined) {
          const output = nested.outputs.find(entry => entry.name.toLowerCase() === parameter.name.toLowerCase())
          if (output !== undefined) {
            applyAssign(session, argument.value.name, '=', output.value)
          }
        }
      })
      return undefined
    }
    const procedure = session.server.procedures.get(procedureKey(statement.procedure))
    if (procedure !== undefined) {
      callUserProcedure(session, procedure, statement, items)
      return undefined
    }
    throw new MssqlError(`Could not find stored procedure '${name}'.`, 2812, 16)
  }

/** Named parameter passed to `executeSql`. */
export type Parameter = {
  readonly name: string,
  readonly value: Value,
  readonly output?: boolean
}

/** Result of executing parameterized SQL — items plus OUTPUT parameter values. */
export type SqlResult = {
  readonly items: readonly Item[],
  readonly outputs: readonly { readonly name: string, readonly value: Value }[]
}

/**
 * Executes a T-SQL batch with optional parameters bound as variables
 * (sp_executesql semantics). Parameters shadow same-named session variables
 * for the duration of the call.
 */
export const executeSql =
  (session: Session, sql: string, parameters: readonly Parameter[] = []): SqlResult => {
    const saved = new Map<string, Variable | undefined>()
    const savedNocount = session.options.get('nocount')
    for (const parameter of parameters) {
      const key = parameter.name.toLowerCase()
      saved.set(key, session.variables.get(key))
      session.variables.set(key, {
        type: { name: 'sql_variant', args: [] },
        value: parameter.value
      } as Variable)
    }
    try {
      const items = executeBatch(session, sql)
      const outputs = parameters
        .filter(parameter => parameter.output === true)
        .map(parameter => ({
          name: parameter.name,
          value: session.variables.get(parameter.name.toLowerCase())?.value ?? null
        }))
      return { items, outputs }
    } finally {
      if (savedNocount === undefined) {
        session.options.delete('nocount')
      } else {
        session.options.set('nocount', savedNocount)
      }
      for (const [ key, variable ] of saved) {
        if (variable === undefined) {
          session.variables.delete(key)
        } else {
          session.variables.set(key, variable)
        }
      }
    }
  }

/**
 * Parses and executes a T-SQL batch, producing result items.
 * @throws MssqlError with MSSQL number/severity on any failure.
 */
const statementTerminatingNumbers =
  new Set([ 245, 515, 547, 2601, 2627, 2714, 3701, 8114, 8115, 8134 ])

const canContinueBatch =
  (error: MssqlError): boolean =>
    error.severity < 20 &&
    (error.statementTerminating || statementTerminatingNumbers.has(error.number) ||
      (error.number >= 11700 && error.number < 11800) ||
      (error.number >= 16900 && error.number < 17000))

export const executeBatch =
  (session: Session, sql: string): Item[] => {
    session.server.current = session
    for (const [ key, function_ ] of session.server.functions) {
      installScalarFunction(session.server, key, function_)
    }
    const items: Item[] = []
    try {
      return withCursorScope(session, () => withTableVariableScope(session, () => {
        const statements = parse(sql)
        let firstError: MssqlError | undefined
        for (const statement of statements) {
          try {
            const signal = executeStatement(session, statement, items)
            session.lastError = 0
            if (signal === 'return') {
              break
            }
          } catch (error) {
            const mapped = errorOf(error)
            firstError ??= mapped
            session.lastError = mapped.number
            session.rowCount = 0
            if (mapped instanceof BatchError) {
              items.push(...mapped.items)
            } else {
              items.push({ kind: 'error', error: mapped })
            }
            const xactAbort = session.options.get('xact_abort') === 'on' &&
              mapped.honorsXactAbort && session.transactionCount > 0
            if (xactAbort) {
              session.db.exec('ROLLBACK')
              session.transactionCount = 0
              session.transactionDoomed = false
              flushSequences(session.server)
            }
            if (!canContinueBatch(mapped) || xactAbort) {
              throw new BatchError(mapped, items)
            }
          }
        }
        if (firstError !== undefined) {
          throw new BatchError(firstError, items)
        }
        return items
      }))
    } catch (error) {
      const mapped = errorOf(error)
      if (!(mapped instanceof BatchError)) {
        session.lastError = mapped.number
      }
      throw mapped
    }
  }
