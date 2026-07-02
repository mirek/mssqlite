import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { parse } from '@mssqlite/tsql'
import { MssqlError, of as errorOf } from './error.ts'
import { columnsOf, type Column } from './metadata.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Session, Value, Variable } from './session.ts'

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

const bindable =
  (value: Value): null | number | bigint | string | Uint8Array =>
    typeof value === 'boolean' ?
      (value ? 1 : 0) :
      value

/** @returns bound parameter object for the variables a rendered statement uses. */
const bindings =
  (session: Session, variables: readonly string[]): Record<string, null | number | bigint | string | Uint8Array> => {
    const bound: Record<string, null | number | bigint | string | Uint8Array> = {}
    for (const name of variables) {
      if (name.startsWith('@@')) {
        bound[`__${name.slice(2)}`] = bindable(globalOf(session, name))
      } else {
        const variable = session.variables.get(name)
        if (variable === undefined) {
          throw new MssqlError(`Must declare the scalar variable "${name}".`, 137, 15)
        }
        bound[name.slice(1)] = bindable(variable.value)
      }
    }
    return bound
  }

/** @returns value of a global variable like `@@rowcount`. */
export const globalOf =
  (session: Session, name: string): Value => {
    switch (name) {
      case '@@rowcount':
        return session.rowCount
      case '@@identity':
        return session.lastIdentity
      case '@@trancount':
        return session.transactionCount
      case '@@error':
        return session.lastError
      case '@@spid':
        return session.spid
      case '@@version':
        return session.server.version
      case '@@servername':
        return session.server.serverName
      case '@@language':
        return 'us_english'
      case '@@lock_timeout':
        return -1
      case '@@max_precision':
        return 38
      case '@@nestlevel':
        return 0
      case '@@fetch_status':
        return -1
      case '@@datefirst':
        return 7
      default:
        throw new MssqlError(`Unrecognized global variable ${name}.`, 137, 15)
    }
  }

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

const query =
  (session: Session, sql: string, variables: readonly string[]): Rows => {
    const statement = session.db.prepare(sql)
    const records = statement.all(bindings(session, variables)) as Record<string, Value>[]
    const columns = columnsOf(session.db, statement, records)
    const rows = records.map(record => columns.map(column => record[column.name] ?? null))
    session.rowCount = rows.length
    return { kind: 'rows', columns, rows, rowCount: rows.length }
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
      case 'update':
      case 'delete':
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
        return 'break'
      case 'continue':
        return 'continue'
      case 'return':
        return 'return'
      case 'beginTransaction':
        if (session.transactionCount === 0) {
          session.db.exec('BEGIN')
        }
        session.transactionCount++
        return undefined
      case 'commitTransaction':
        if (session.transactionCount === 0) {
          throw new MssqlError('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.', 3902, 16)
        }
        if (session.transactionCount === 1) {
          session.db.exec('COMMIT')
        }
        session.transactionCount--
        return undefined
      case 'rollbackTransaction':
        if (statement.name !== undefined && !statement.name.startsWith('@')) {
          // Named rollback targets a savepoint when one exists.
          try {
            session.db.exec(`ROLLBACK TO SAVEPOINT "${statement.name.replaceAll('"', '""')}"`)
            return undefined
          } catch {
            // Fall through to a full rollback of the named transaction.
          }
        }
        if (session.transactionCount > 0) {
          session.db.exec('ROLLBACK')
          session.transactionCount = 0
        }
        return undefined
      case 'saveTransaction':
        // A bare SAVEPOINT implicitly opens a SQLite transaction; keep
        // @@TRANCOUNT in step so a later BEGIN TRAN doesn't hit "cannot start a
        // transaction within a transaction" and the work isn't left untracked.
        if (session.transactionCount === 0) {
          session.db.exec('BEGIN')
          session.transactionCount = 1
        }
        session.db.exec(`SAVEPOINT "${statement.name.replaceAll('"', '""')}"`)
        return undefined
      case 'use':
        session.database = statement.database
        return undefined
      case 'print':
        items.push({ kind: 'message', text: String(evaluate(session, statement.expression) ?? '') })
        return undefined
      case 'throw': {
        const number = statement.number === undefined ? 50000 : Number(evaluate(session, statement.number))
        const message = statement.message === undefined ?
          'An error was raised.' :
          String(evaluate(session, statement.message) ?? '')
        const state = statement.state === undefined ? 1 : Number(evaluate(session, statement.state))
        throw new MssqlError(message, number, 16, state)
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
