import * as Catalog from '@mssqlite/catalog'
import * as Transpile from '@mssqlite/transpile'
import { MssqlError } from './error.ts'
import {
  installRowversionTriggers,
  isRowversionType,
  validateRowversionColumns
} from './rowversion.ts'
import { functionKey } from './session.ts'
import * as Character from './character.ts'
import * as Identity from './identity.ts'
import type { Ast } from '@mssqlite/tsql'
import { stateForName } from './database.ts'
import type { Session, TableVariable } from './session.ts'

const resolveName =
  (session: Session, name: Ast.QualifiedName): Ast.QualifiedName => {
    const transition = name.length === 1 ?
      session.transitionTables.get(name[0]?.toLowerCase() ?? '') :
      undefined
    if (transition !== undefined) {
      return transition.table
    }
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
      case 'variable': {
        const type = session.variables.get(value.name.toLowerCase())?.type
        const character = type === undefined ? undefined : Character.normalize(type, 1)
        const resolved = character ?? type
        return resolved !== undefined &&
          Transpile.Type.category(resolved) !== undefined &&
          Transpile.Type.category(resolved) !== 'variant' ?
          { kind: 'cast', expression: value, type: resolved, try_: false } : value
      }
      case 'unary':
        return { ...value, operand: resolveExpression(session, value.operand) }
      case 'binaryOp':
        return {
          ...value,
          left: resolveExpression(session, value.left),
          right: resolveExpression(session, value.right)
        }
      case 'call': {
        const function_ = session.server.functions.get(functionKey(value.name))
        const args = value.args.map((argument, index) => {
          if (argument.kind !== 'default') {
            return argument
          }
          const default_ = function_?.parameters[index]?.default_
          if (default_ === undefined) {
            throw new MssqlError(
              `Function parameter ${index + 1} has no default value.`, 201, 16)
          }
          return default_
        })
        return {
          ...value,
          args: args.map(argument => resolveExpression(session, argument)),
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
      }
      case 'cast':
        return { ...value, expression: resolveExpression(session, value.expression) }
      case 'collate':
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

const resolveGroupingSetItem =
  (session: Session, item: Ast.GroupingSetItem): Ast.GroupingSetItem =>
    item.kind === 'expressions' ?
      { ...item, expressions: item.expressions.map(value => resolveExpression(session, value)) } :
      {
        ...item,
        units: item.units.map(unit => unit.map(value => resolveExpression(session, value)))
      }

const resolveGroupByItem =
  (session: Session, item: Ast.GroupByItem): Ast.GroupByItem =>
    item.kind === 'sets' ?
      { ...item, sets: item.sets.map(set => resolveGroupingSetItem(session, set)) } :
      resolveGroupingSetItem(session, item)

/** @returns declared T-SQL type reconstructed from one catalog column. */
export const typeNameOfCatalogRow =
  (row: Catalog.ColumnRow): Ast.SourceColumn['type'] => {
    const type = Catalog.TypeRow.rows.find(candidate => candidate.userTypeId === row.user_type_id) ??
      Catalog.TypeRow.rows.find(candidate => candidate.systemTypeId === row.system_type_id)
    if (type === undefined) {
      return undefined
    }
    const args: readonly (number | 'max')[] = (() => {
      switch (type.name) {
        case 'decimal':
        case 'numeric':
          return [ row.precision, row.scale ]
        case 'char':
        case 'varchar':
        case 'binary':
        case 'varbinary':
          return [ row.max_length === -1 ? 'max' : row.max_length ]
        case 'nchar':
        case 'nvarchar':
          return [ row.max_length === -1 ? 'max' : row.max_length / 2 ]
        case 'time':
        case 'datetime2':
        case 'datetimeoffset':
          return [ row.scale ]
        default:
          return []
      }
    })()
    return { name: type.name, args }
  }

const sourceColumns =
  (session: Session, name: Ast.QualifiedName, pragma: string): readonly Ast.SourceColumn[] => {
    const tableName = name[name.length - 1] ?? ''
    const variable = [ ...session.tableVariables.values(), ...session.transitionTables.values() ].find(candidate =>
      candidate.table[candidate.table.length - 1]?.toLowerCase() === tableName.toLowerCase())
    if (variable !== undefined && variable.columns.length > 0) {
      return variable.columns.map(column => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable !== false && column.primaryKey !== true,
        ...column.collate === undefined ? {} : { collation: column.collate }
      }))
    }
    const catalog = stateForName(session, name).db
    const objectId = Catalog.objectIdOf(catalog, name)
    if (objectId !== undefined) {
      return Catalog.tableColumns(catalog, objectId).map(column => {
        const type = typeNameOfCatalogRow(column)
        return {
          name: column.name,
          ...type === undefined ? {} : { type },
          nullable: column.is_nullable !== 0,
          ...column.collation_name === null ? {} : { collation: column.collation_name }
        }
      })
    }
    const columns = session.db.prepare(pragma).all() as { name: string }[]
    return columns.map(column => ({ name: column.name }))
  }

/** Declared source columns for an already resolved table name. */
export const columnsOfTable =
  (session: Session, name: Ast.QualifiedName): readonly Ast.SourceColumn[] => {
    return sourceColumns(session, name, Transpile.Quote.pragmaTableInfo(name))
  }

type Substitutions =
  ReadonlyMap<string, Ast.Expression>

const substituteExpression =
  (value: Ast.Expression, values: Substitutions): Ast.Expression => {
    if (value.kind === 'variable') {
      return values.get(value.name.toLowerCase()) ?? value
    }
    switch (value.kind) {
      case 'unary':
        return { ...value, operand: substituteExpression(value.operand, values) }
      case 'binaryOp':
        return {
          ...value,
          left: substituteExpression(value.left, values),
          right: substituteExpression(value.right, values)
        }
      case 'call':
        return {
          ...value,
          args: value.args.map(argument => substituteExpression(argument, values)),
          ...value.over === undefined ? {} : {
            over: {
              partitionBy: value.over.partitionBy.map(argument => substituteExpression(argument, values)),
              orderBy: value.over.orderBy.map(item => ({
                ...item,
                expression: substituteExpression(item.expression, values)
              }))
            }
          }
        }
      case 'cast':
        return { ...value, expression: substituteExpression(value.expression, values) }
      case 'collate':
        return { ...value, expression: substituteExpression(value.expression, values) }
      case 'convert':
        return {
          ...value,
          expression: substituteExpression(value.expression, values),
          ...value.style === undefined ? {} : {
            style: substituteExpression(value.style, values)
          }
        }
      case 'case':
        return {
          ...value,
          ...value.operand === undefined ? {} : {
            operand: substituteExpression(value.operand, values)
          },
          whens: value.whens.map(when => ({
            when: substituteExpression(when.when, values),
            then: substituteExpression(when.then, values)
          })),
          ...value.else_ === undefined ? {} : {
            else_: substituteExpression(value.else_, values)
          }
        }
      case 'in':
        return {
          ...value,
          expression: substituteExpression(value.expression, values),
          values: Array.isArray(value.values) ?
            value.values.map(item => substituteExpression(item, values)) :
            substituteSelect(value.values as Ast.Select, values)
        }
      case 'like':
        return {
          ...value,
          expression: substituteExpression(value.expression, values),
          pattern: substituteExpression(value.pattern, values),
          ...value.escape === undefined ? {} : {
            escape: substituteExpression(value.escape, values)
          }
        }
      case 'between':
        return {
          ...value,
          expression: substituteExpression(value.expression, values),
          low: substituteExpression(value.low, values),
          high: substituteExpression(value.high, values)
        }
      case 'isNull':
        return { ...value, expression: substituteExpression(value.expression, values) }
      case 'exists':
      case 'subquery':
        return { ...value, select: substituteSelect(value.select, values) }
      default:
        return value
    }
  }

const substituteSource =
  (source: Ast.TableSource, values: Substitutions): Ast.TableSource => {
    switch (source.kind) {
      case 'function':
        return {
          ...source,
          args: source.args.map(argument => substituteExpression(argument, values))
        }
      case 'derived':
        return { ...source, select: substituteSelect(source.select, values) }
      case 'values':
        return {
          ...source,
          rows: source.rows.map(row =>
            row.map(value => substituteExpression(value, values)))
        }
      case 'pivot':
        return {
          ...source,
          source: substituteSource(source.source, values),
          aggregate: {
            ...source.aggregate,
            expression: substituteExpression(source.aggregate.expression, values)
          }
        }
      case 'unpivot':
        return { ...source, source: substituteSource(source.source, values) }
      case 'join':
        return {
          ...source,
          left: substituteSource(source.left, values),
          right: substituteSource(source.right, values),
          ...source.on === undefined ? {} : {
            on: substituteExpression(source.on, values)
          }
        }
      default:
        return source
    }
  }

const substituteGrouping =
  (item: Ast.GroupByItem, values: Substitutions): Ast.GroupByItem => {
    if (item.kind === 'sets') {
      return { ...item, sets: item.sets.map(set => substituteGrouping(set, values) as Ast.GroupingSetItem) }
    }
    return item.kind === 'expressions' ?
      { ...item, expressions: item.expressions.map(value => substituteExpression(value, values)) } :
      {
        ...item,
        units: item.units.map(unit => unit.map(value => substituteExpression(value, values)))
      }
  }

const substituteSelect =
  (select: Ast.Select, values: Substitutions): Ast.Select => ({
    ...select,
    ...select.ctes === undefined ? {} : {
      ctes: select.ctes.map(cte => ({ ...cte, select: substituteSelect(cte.select, values) }))
    },
    ...select.top === undefined ? {} : {
      top: { ...select.top, count: substituteExpression(select.top.count, values) }
    },
    items: select.items.map(item => item.kind === 'star' ? item : {
      ...item,
      expression: substituteExpression(item.expression, values)
    }),
    ...select.from === undefined ? {} : { from: substituteSource(select.from, values) },
    ...select.where === undefined ? {} : { where: substituteExpression(select.where, values) },
    ...select.groupBy === undefined ? {} : {
      groupBy: select.groupBy.map(item => substituteGrouping(item, values))
    },
    ...select.having === undefined ? {} : { having: substituteExpression(select.having, values) },
    ...select.orderBy === undefined ? {} : {
      orderBy: select.orderBy.map(item => ({
        ...item,
        expression: substituteExpression(item.expression, values)
      }))
    },
    ...select.offset === undefined ? {} : { offset: substituteExpression(select.offset, values) },
    ...select.fetch === undefined ? {} : { fetch: substituteExpression(select.fetch, values) },
    ...select.union === undefined ? {} : {
      union: { ...select.union, select: substituteSelect(select.union.select, values) }
    }
  })

const inlineFunctionSource =
  (
    session: Session,
    source: Ast.TableSource & { kind: 'function' }
  ): Ast.TableSource | undefined => {
    const function_ = session.server.functions.get(functionKey(source.name))
    if (function_?.returns.kind !== 'table') {
      return undefined
    }
    if (source.args.length > function_.parameters.length) {
      throw new MssqlError(`Function ${source.name.join('.')} has too many arguments specified.`, 8144, 16)
    }
    const values = new Map<string, Ast.Expression>()
    function_.parameters.forEach((parameter, index) => {
      const supplied = source.args[index]
      const value = supplied === undefined || supplied.kind === 'default' ? parameter.default_ : supplied
      if (value === undefined) {
        throw new MssqlError(
          `Function '${source.name.join('.')}' expects parameter '${parameter.name}', which was not supplied.`,
          201, 16)
      }
      values.set(parameter.name.toLowerCase(), value)
    })
    let select = substituteSelect(function_.returns.select, values)
    if (source.columns !== undefined) {
      if (source.columns.length !== select.items.length ||
        select.items.some(item => item.kind !== 'expression')) {
        throw new MssqlError('Inline function column alias list has the wrong shape.', 8158, 16)
      }
      select = {
        ...select,
        items: select.items.map((item, index) => {
          if (item.kind !== 'expression') {
            return item
          }
          const alias = source.columns?.[index] ?? item.alias
          return { ...item, ...alias === undefined ? {} : { alias } }
        })
      }
    }
    return {
      kind: 'derived',
      select: resolveSelect(session, select),
      alias: source.alias ?? (source.name[source.name.length - 1] ?? '')
    }
  }

const definitelyNotNull =
  (value: Ast.Expression): boolean =>
    [ 'number', 'string', 'binary' ].includes(value.kind)

const resolveValuesSource =
  (
    session: Session,
    source: Ast.TableSource & { kind: 'values' },
    visible?: Ast.TableSource
  ): Ast.TableSource => {
    const width = source.rows[0]?.length ?? 0
    if (source.rows.some(row => row.length !== width)) {
      throw new MssqlError(
        'The number of columns for each row in a table value constructor must be the same.',
        10709, 16)
    }
    if (source.columns === undefined) {
      throw new MssqlError(
        `No column name was specified for column 1 of '${source.alias}'.`, 8155, 16, 2)
    }
    if (width > source.columns.length) {
      throw new MssqlError(
        `'${source.alias}' has more columns than were specified in the column list.`, 8158, 16)
    }
    if (width < source.columns.length) {
      throw new MssqlError(
        `'${source.alias}' has fewer columns than were specified in the column list.`, 8159, 16)
    }
    const names = new Set<string>()
    for (const name of source.columns) {
      if (names.has(name.toLowerCase())) {
        throw new MssqlError(
          `The column '${name}' was specified multiple times for '${source.alias}'.`, 8156, 16)
      }
      names.add(name.toLowerCase())
    }
    const rows = source.rows.map(row => row.map(value => resolveExpression(session, value)))
    const ctx = Transpile.Context.of()
    const columnMetadata = Transpile.Context.withSourceTypes(ctx, visible, () =>
      source.columns?.map((name, index): Ast.SourceColumn => {
        const values = rows.map(row => row[index] as Ast.Expression)
        return {
          name,
          type: Transpile.Implicit.common(ctx, values) ?? { name: 'int', args: [] },
          nullable: values.some(value => !definitelyNotNull(value))
        }
      }) ?? [])
    return { ...source, rows, columnMetadata }
  }

const resolveTableSource =
  (session: Session, source: Ast.TableSource, visible?: Ast.TableSource): Ast.TableSource => {
    switch (source.kind) {
      case 'table': {
        const transitionAlias = source.name.length === 1 &&
          session.transitionTables.has(source.name[0]?.toLowerCase() ?? '') ?
          source.name[0] : undefined
        const name = resolveName(session, source.name)
        return {
          ...source,
          name,
          ...source.alias === undefined && transitionAlias !== undefined ?
            { alias: transitionAlias } :
            {},
          columns: columnsOfTable(session, name)
        }
      }
      case 'function':
        {
          const inline = inlineFunctionSource(session, source)
          if (inline !== undefined) {
            return inline
          }
        }
        return {
          ...source,
          args: source.args.map(argument => resolveExpression(session, argument))
        }
      case 'derived':
      {
        const select = resolveSelect(session, source.select)
        const columns = Transpile.Implicit.projectionHints(select, visible)
        return {
          ...source,
          select,
          ...columns === undefined ? {} : { columns }
        }
      }
      case 'values':
        return resolveValuesSource(session, source, visible)
      case 'pivot':
        return {
          ...source,
          source: resolveTableSource(session, source.source),
          aggregate: {
            ...source.aggregate,
            expression: resolveExpression(session, source.aggregate.expression)
          },
          pivotColumn: source.pivotColumn
        }
      case 'unpivot':
        return { ...source, source: resolveTableSource(session, source.source) }
      case 'join': {
        const left = resolveTableSource(session, source.left, visible)
        const right = resolveTableSource(session, source.right, left)
        return {
          ...source,
          left,
          right,
          ...source.on === undefined ? {} : { on: resolveExpression(session, source.on) }
        }
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
      groupBy: select.groupBy.map(item => resolveGroupByItem(session, item))
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
    const columns = Transpile.Computed.columns(declaration.columns)
    validateRowversionColumns(columns)
    Identity.validateColumns(columns)
    const physical = [ `#__mssqlite_table_${session.spid}_${session.nextTableVariable}` ]
    const identity = Identity.temporaryIdentity(physical, columns)
    const table: TableVariable = {
      table: physical,
      columns,
      constraints: declaration.constraints,
      ...identity === undefined ? {} : { identity }
    }
    session.nextTableVariable++
    session.tableVariables.set(key, table)
    session.db.exec(Transpile.statement({
      kind: 'createTable',
      name: table.table,
      columns: table.columns,
      constraints: table.constraints
    }).sql)
    const rowversion = columns.find(column => isRowversionType(column.type))
    if (rowversion !== undefined) {
      installRowversionTriggers(session.db, table.table, rowversion.name)
    }
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

/** Async variant used by cooperative server execution. */
export const withTableVariableScopeAsync =
  async <T>(session: Session, run: () => Promise<T>): Promise<T> => {
    const saved = new Map(session.tableVariables)
    session.tableVariables.clear()
    try {
      return await run()
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
