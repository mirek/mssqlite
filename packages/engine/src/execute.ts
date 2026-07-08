import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { parse } from '@mssqlite/tsql'
import { bindings } from './bind.ts'
import { emitOutput, expandOutputStars, query } from './output.ts'
import { executeMerge } from './merge.ts'
import { MssqlError, of as errorOf } from './error.ts'
import { columnsOf, type Column } from './metadata.ts'
import type { Ast } from '@mssqlite/tsql'
import { procedureKey, type Procedure, type Session, type Value, type Variable } from './session.ts'

/** Result set of a SELECT. */
export type Rows = {
  readonly kind: 'rows',
  readonly columns: readonly Column[],
  readonly rows: readonly (readonly Value[])[],
  readonly rowCount: number
}

/** Row count of a DML statement. */
export type Count = {
  readonly kind: 'count',
  readonly rowCount: number
}

/** Informational message (PRINT). */
export type Message = {
  readonly kind: 'message',
  readonly text: string
}

/** Batch execution item. */
export type Item =
  | Rows
  | Count
  | Message

/** Control-flow signal raised by BREAK / CONTINUE / RETURN. */
type Signal =
  'break' | 'continue' | 'return' | undefined

/** @returns scalar value of a T-SQL expression evaluated in session context. */
export const evaluate =
  (session: Session, expression: Ast.Expression): Value => {
    const rendered = Transpile.scalar(expression)
    const statement = session.db.prepare(`SELECT (${rendered.sql}) AS value`)
    const row = statement.get(bindings(session, rendered.variables)) as { value: Value } | undefined
    return row?.value ?? null
  }

const truthy =
  (session: Session, condition: Ast.Expression): boolean => {
    const rendered = Transpile.scalar(condition)
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
    const objectId = Catalog.objectIdOf(session.db, table)
    return objectId !== undefined &&
      Catalog.tableColumns(session.db, objectId).some(column => column.is_identity === 1)
  }

const runRendered =
  (session: Session, rendered: Transpile.Rendered, items: Item[]): void => {
    const statement = session.db.prepare(rendered.sql)
    const result = statement.run(bindings(session, rendered.variables))
    session.rowCount = Number(result.changes)
    items.push({ kind: 'count', rowCount: Number(result.changes) })
  }

/** Runs a DML statement whose OUTPUT clause renders as SQLite RETURNING. */
const runWithOutput =
  (session: Session, statement: Ast.Statement & { kind: 'insert' | 'update' | 'delete' }, output: Ast.Output, items: Item[]): void => {
    const rendered = Transpile.statement(statement)
    const prepared = session.db.prepare(rendered.sql)
    const records = prepared.all(bindings(session, rendered.variables)) as Record<string, Value>[]
    const columns = columnsOf(session.db, prepared, records)
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
    if (operator === '=') {
      variable.value = value
    } else {
      const current = variable.value
      if (current === null || value === null) {
        variable.value = null
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
    items.push({ kind: 'count', rowCount: count.n })
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

const executeStatement =
  (session: Session, statement: Ast.Statement, items: Item[]): Signal => {
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
        items.push(query(session, rendered.sql, rendered.variables))
        return undefined
      }
      case 'insert': {
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
        items.push({ kind: 'count', rowCount: Number(result.changes) })
        return undefined
      }
      case 'merge':
        executeMerge(session, statement, items)
        return undefined
      case 'update':
      case 'delete':
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
        const rendered = Transpile.statement(statement)
        session.db.exec(rendered.sql)
        Catalog.createTable(session.db, statement)
        return undefined
      }
      case 'dropTable':
        session.db.exec(Transpile.statement(statement).sql)
        for (const name of statement.names) {
          Catalog.dropTable(session.db, name)
        }
        return undefined
      case 'createIndex':
        session.db.exec(Transpile.statement(statement).sql)
        Catalog.createIndex(session.db, statement)
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
      case 'alterTable':
        session.db.exec(Transpile.statement(statement).sql)
        switch (statement.action.kind) {
          case 'addColumns':
            Catalog.addColumns(session.db, statement.name, statement.action.columns)
            break
          case 'dropColumns':
            Catalog.dropColumns(session.db, statement.name, statement.action.columns)
            break
          default:
            break
        }
        return undefined
      case 'declare':
        for (const declaration of statement.declarations) {
          const value = declaration.initial === undefined ?
            null :
            evaluate(session, declaration.initial)
          session.variables.set(declaration.name.toLowerCase(), {
            type: declaration.type,
            value
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
        throw new MssqlError(text, number, severity, state)
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
    session.variables.clear()
    for (const [ key, variable ] of scope) {
      session.variables.set(key, variable)
    }
    session.returnValue = null
    session.nestLevel++
    const outputs = new Map<string, Value>()
    let status: Value = null
    try {
      for (const inner of procedure.body) {
        const signal = executeStatement(session, inner, items)
        if (signal === 'return') {
          break
        }
      }
      status = session.returnValue
      for (const key of outputTargets.keys()) {
        outputs.set(key, session.variables.get(key)?.value ?? null)
      }
    } finally {
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
export const executeBatch =
  (session: Session, sql: string): Item[] => {
    session.server.current = session
    const items: Item[] = []
    try {
      const statements = parse(sql)
      for (const statement of statements) {
        const signal = executeStatement(session, statement, items)
        if (signal === 'return') {
          break
        }
      }
      session.lastError = 0
      return items
    } catch (error) {
      const mapped = errorOf(error)
      session.lastError = mapped.number
      throw mapped
    }
  }
