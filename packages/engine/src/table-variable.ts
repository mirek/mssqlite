import * as Transpile from '@mssqlite/transpile'
import { MssqlError } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { Session, TableVariable } from './session.ts'

const resolveName =
  (session: Session, name: Ast.QualifiedName): Ast.QualifiedName => {
    const variable = name.length === 1 && name[0]?.startsWith('@') === true ?
      name[0] :
      undefined
    if (variable === undefined) {
      return name
    }
    const table = session.tableVariables.get(variable.toLowerCase())
    if (table === undefined) {
      throw new MssqlError(`Must declare the table variable "${variable}".`, 1087, 15)
    }
    return table.table
  }

const resolveExpression =
  (session: Session, value: Ast.Expression): Ast.Expression => {
    switch (value.kind) {
      case 'unary':
        return { ...value, operand: resolveExpression(session, value.operand) }
      case 'binaryOp':
        return {
          ...value,
          left: resolveExpression(session, value.left),
          right: resolveExpression(session, value.right)
        }
      case 'call':
        return {
          ...value,
          args: value.args.map(argument => resolveExpression(session, argument)),
          ...value.over === undefined ? {} : {
            over: {
              partitionBy: value.over.partitionBy.map(argument => resolveExpression(session, argument)),
              orderBy: value.over.orderBy.map(item => ({
                ...item,
                expression: resolveExpression(session, item.expression)
              }))
            }
          }
        }
      case 'cast':
        return { ...value, expression: resolveExpression(session, value.expression) }
      case 'convert':
        return {
          ...value,
          expression: resolveExpression(session, value.expression),
          ...value.style === undefined ? {} : { style: resolveExpression(session, value.style) }
        }
      case 'case':
        return {
          ...value,
          ...value.operand === undefined ? {} : { operand: resolveExpression(session, value.operand) },
          whens: value.whens.map(when => ({
            when: resolveExpression(session, when.when),
            then: resolveExpression(session, when.then)
          })),
          ...value.else_ === undefined ? {} : { else_: resolveExpression(session, value.else_) }
        }
      case 'in':
        return {
          ...value,
          expression: resolveExpression(session, value.expression),
          values: Array.isArray(value.values) ?
            value.values.map(item => resolveExpression(session, item)) :
            resolveSelect(session, value.values as Ast.Select)
        }
      case 'like':
        return {
          ...value,
          expression: resolveExpression(session, value.expression),
          pattern: resolveExpression(session, value.pattern),
          ...value.escape === undefined ? {} : { escape: resolveExpression(session, value.escape) }
        }
      case 'between':
        return {
          ...value,
          expression: resolveExpression(session, value.expression),
          low: resolveExpression(session, value.low),
          high: resolveExpression(session, value.high)
        }
      case 'isNull':
        return { ...value, expression: resolveExpression(session, value.expression) }
      case 'exists':
      case 'subquery':
        return { ...value, select: resolveSelect(session, value.select) }
      default:
        return value
    }
  }

/** @returns expression with table variables in nested queries resolved. */
export const resolveTableVariableExpression =
  (session: Session, value: Ast.Expression): Ast.Expression =>
    resolveExpression(session, value)

const resolveItem =
  (session: Session, item: Ast.SelectItem): Ast.SelectItem =>
    item.kind === 'star' ?
      item :
      { ...item, expression: resolveExpression(session, item.expression) }

const resolveTableSource =
  (session: Session, source: Ast.TableSource): Ast.TableSource => {
    switch (source.kind) {
      case 'table':
        return { ...source, name: resolveName(session, source.name) }
      case 'function':
        return {
          ...source,
          args: source.args.map(argument => resolveExpression(session, argument))
        }
      case 'derived':
        return { ...source, select: resolveSelect(session, source.select) }
      case 'join':
        return {
          ...source,
          left: resolveTableSource(session, source.left),
          right: resolveTableSource(session, source.right),
          ...source.on === undefined ? {} : { on: resolveExpression(session, source.on) }
        }
      default:
        return source
    }
  }

const resolveSelect =
  (session: Session, select: Ast.Select): Ast.Select => ({
    ...select,
    ...select.ctes === undefined ? {} : {
      ctes: select.ctes.map(cte => ({ ...cte, select: resolveSelect(session, cte.select) }))
    },
    ...select.top === undefined ? {} : {
      top: { ...select.top, count: resolveExpression(session, select.top.count) }
    },
    items: select.items.map(item => resolveItem(session, item)),
    ...select.from === undefined ? {} : { from: resolveTableSource(session, select.from) },
    ...select.where === undefined ? {} : { where: resolveExpression(session, select.where) },
    ...select.groupBy === undefined ? {} : {
      groupBy: select.groupBy.map(value => resolveExpression(session, value))
    },
    ...select.having === undefined ? {} : { having: resolveExpression(session, select.having) },
    ...select.orderBy === undefined ? {} : {
      orderBy: select.orderBy.map(item => ({
        ...item,
        expression: resolveExpression(session, item.expression)
      }))
    },
    ...select.offset === undefined ? {} : { offset: resolveExpression(session, select.offset) },
    ...select.fetch === undefined ? {} : { fetch: resolveExpression(session, select.fetch) },
    ...select.union === undefined ? {} : {
      union: { ...select.union, select: resolveSelect(session, select.union.select) }
    }
  })

const resolveOutput =
  (session: Session, output: Ast.Output): Ast.Output => ({
    ...output,
    items: output.items.map(item => resolveItem(session, item)),
    ...output.into === undefined ? {} : {
      into: { ...output.into, table: resolveName(session, output.into.table) }
    }
  })

/** @returns directly executable statement with table-variable names resolved. */
export const resolveTableVariables =
  (session: Session, statement: Ast.Statement): Ast.Statement => {
    switch (statement.kind) {
      case 'select':
        return resolveSelect(session, statement)
      case 'insert':
        return {
          ...statement,
          table: resolveName(session, statement.table),
          ...statement.output === undefined ? {} : { output: resolveOutput(session, statement.output) },
          source: statement.source.kind === 'select' ?
            { ...statement.source, select: resolveSelect(session, statement.source.select) } :
            statement.source.kind === 'values' ?
              {
                ...statement.source,
                rows: statement.source.rows.map(row =>
                  row.map(value => resolveExpression(session, value)))
              } :
              statement.source
        }
      case 'update':
        return {
          ...statement,
          target: resolveName(session, statement.target),
          ...statement.top === undefined ? {} : { top: resolveExpression(session, statement.top) },
          set: statement.set.map(assignment => ({
            ...assignment,
            value: resolveExpression(session, assignment.value)
          })),
          ...statement.output === undefined ? {} : { output: resolveOutput(session, statement.output) },
          ...statement.from === undefined ? {} : { from: resolveTableSource(session, statement.from) },
          ...statement.where === undefined ? {} : { where: resolveExpression(session, statement.where) }
        }
      case 'delete':
        return {
          ...statement,
          target: resolveName(session, statement.target),
          ...statement.top === undefined ? {} : { top: resolveExpression(session, statement.top) },
          ...statement.output === undefined ? {} : { output: resolveOutput(session, statement.output) },
          ...statement.from === undefined ? {} : { from: resolveTableSource(session, statement.from) },
          ...statement.where === undefined ? {} : { where: resolveExpression(session, statement.where) }
        }
      case 'merge':
        return {
          ...statement,
          target: resolveName(session, statement.target),
          source: resolveTableSource(session, statement.source),
          on: resolveExpression(session, statement.on),
          whens: statement.whens.map(when => ({
            ...when,
            ...when.condition === undefined ? {} : {
              condition: resolveExpression(session, when.condition)
            },
            action: when.action.kind === 'update' ?
              {
                ...when.action,
                set: when.action.set.map(assignment => ({
                  ...assignment,
                  value: resolveExpression(session, assignment.value)
                }))
              } :
              when.action.kind === 'insert' && when.action.values !== undefined ?
                {
                  ...when.action,
                  values: when.action.values.map(value => resolveExpression(session, value))
                } :
                when.action
          })),
          ...statement.output === undefined ? {} : { output: resolveOutput(session, statement.output) }
        }
      case 'truncate':
        return { ...statement, table: resolveName(session, statement.table) }
      default:
        return statement
    }
  }

/** Creates a temp backing table and adds it to the active variable scope. */
export const declareTableVariable =
  (session: Session, declaration: Ast.Declaration & { kind: 'table' }): void => {
    const key = declaration.name.toLowerCase()
    if (session.tableVariables.has(key)) {
      throw new MssqlError(
        `The variable name '${declaration.name}' has already been declared. Variable names must be unique within a query batch or stored procedure.`,
        134, 15)
    }
    const table: TableVariable = {
      table: [ `#__mssqlite_table_${session.spid}_${session.nextTableVariable}` ],
      columns: declaration.columns,
      constraints: declaration.constraints
    }
    session.nextTableVariable++
    session.tableVariables.set(key, table)
    session.db.exec(Transpile.statement({
      kind: 'createTable',
      name: table.table,
      columns: table.columns,
      constraints: table.constraints
    }).sql)
  }

/** Runs a batch or procedure with an isolated table-variable scope. */
export const withTableVariableScope =
  <T>(session: Session, run: () => T): T => {
    const saved = new Map(session.tableVariables)
    session.tableVariables.clear()
    try {
      return run()
    } finally {
      for (const table of session.tableVariables.values()) {
        session.db.exec(`DROP TABLE IF EXISTS ${Transpile.Quote.objectName(table.table)}`)
      }
      session.tableVariables.clear()
      for (const [ name, table ] of saved) {
        session.tableVariables.set(name, table)
      }
    }
  }
