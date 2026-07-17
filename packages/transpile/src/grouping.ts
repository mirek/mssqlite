import { unsupported } from './error.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

const key =
  (value: Ast.Expression): string =>
    JSON.stringify(value)

const flatten =
  (units: readonly Ast.GroupingUnit[]): readonly Ast.Expression[] =>
    units.flatMap(unit => unit)

const expandItem =
  (item: Ast.GroupingSetItem): readonly (readonly Ast.Expression[])[] => {
    switch (item.kind) {
      case 'expressions':
        return [ item.expressions ]
      case 'rollup': {
        const sets: Ast.Expression[][] = []
        for (let length = item.units.length; length >= 0; length--) {
          sets.push([ ...flatten(item.units.slice(0, length)) ])
        }
        return sets
      }
      case 'cube': {
        if (item.units.length > 12) {
          return unsupported('CUBE supports at most 12 grouping units.')
        }
        const sets: Ast.Expression[][] = []
        for (let mask = (2 ** item.units.length) - 1; mask >= 0; mask--) {
          sets.push(item.units.flatMap((unit, index) =>
            (mask & (1 << (item.units.length - index - 1))) === 0 ? [] : unit))
        }
        return sets
      }
      default:
        return unsupported('Unsupported grouping-set item.')
    }
  }

const alternatives =
  (item: Ast.GroupByItem): readonly (readonly Ast.Expression[])[] =>
    item.kind === 'sets' ? item.sets.flatMap(expandItem) : expandItem(item)

/** @returns ordered grouping sets, preserving duplicates like SQL Server. */
export const expand =
  (items: readonly Ast.GroupByItem[]): readonly (readonly Ast.Expression[])[] => {
    let sets: readonly (readonly Ast.Expression[])[] = [ [] ]
    for (const item of items) {
      sets = sets.flatMap(prefix => alternatives(item).map(suffix => [ ...prefix, ...suffix ]))
      if (sets.length > 4096) {
        return unsupported('A GROUP BY clause can generate at most 4096 grouping sets.')
      }
    }
    return sets
  }

/** @returns plain SQLite GROUP BY expressions, or undefined when expansion is required. */
export const ordinary =
  (items: readonly Ast.GroupByItem[]): readonly Ast.Expression[] | undefined => {
    if (items.some(item => item.kind !== 'expressions' || item.expressions.length === 0)) {
      return undefined
    }
    return items.flatMap(item => item.kind === 'expressions' ? item.expressions : [])
  }

const aggregateNames = new Set([
  'avg', 'checksum_agg', 'count', 'count_big', 'group_concat', 'max', 'min',
  'stdev', 'stdevp', 'string_agg', 'sum', 'var', 'varp'
])

/** @returns whether an expression contains an aggregate in the current SELECT scope. */
export const containsAggregate =
  (value: Ast.Expression): boolean => {
    switch (value.kind) {
      case 'unary':
        return containsAggregate(value.operand)
      case 'binaryOp':
        return containsAggregate(value.left) || containsAggregate(value.right)
      case 'call':
        return (value.over === undefined &&
          aggregateNames.has((value.name[value.name.length - 1] ?? '').toLowerCase())) ||
          value.args.some(containsAggregate)
      case 'cast':
      case 'collate':
        return containsAggregate(value.expression)
      case 'convert':
        return containsAggregate(value.expression) ||
          (value.style !== undefined && containsAggregate(value.style))
      case 'case':
        return (value.operand !== undefined && containsAggregate(value.operand)) ||
          value.whens.some(when => containsAggregate(when.when) || containsAggregate(when.then)) ||
          (value.else_ !== undefined && containsAggregate(value.else_))
      case 'in':
        return containsAggregate(value.expression) ||
          (Array.isArray(value.values) && value.values.some(containsAggregate))
      case 'like':
        return containsAggregate(value.expression) || containsAggregate(value.pattern) ||
          (value.escape !== undefined && containsAggregate(value.escape))
      case 'between':
        return containsAggregate(value.expression) || containsAggregate(value.low) ||
          containsAggregate(value.high)
      case 'isNull':
        return containsAggregate(value.expression)
      default:
        return false
    }
  }

const rewrite =
  (
    value: Ast.Expression,
    all: ReadonlySet<string>,
    active: ReadonlySet<string>
  ): Ast.Expression => {
    const valueKey = key(value)
    if (all.has(valueKey) && !active.has(valueKey)) {
      return { kind: 'null' }
    }
    switch (value.kind) {
      case 'unary':
        return { ...value, operand: rewrite(value.operand, all, active) }
      case 'binaryOp':
        return {
          ...value,
          left: rewrite(value.left, all, active),
          right: rewrite(value.right, all, active)
        }
      case 'call': {
        const name = (value.name[value.name.length - 1] ?? '').toLowerCase()
        if (name === 'grouping') {
          const argument = value.args[0]
          if (value.args.length !== 1 || argument === undefined || !all.has(key(argument))) {
            return unsupported('GROUPING expects one expression from the GROUP BY clause.')
          }
          return { kind: 'number', value: active.has(key(argument)) ? '0' : '1' }
        }
        if (aggregateNames.has(name) && value.over === undefined) {
          return value
        }
        return {
          ...value,
          args: value.args.map(argument => rewrite(argument, all, active)),
          ...value.over === undefined ? {} : {
            over: {
              partitionBy: value.over.partitionBy.map(argument => rewrite(argument, all, active)),
              orderBy: value.over.orderBy.map(item => ({
                ...item,
                expression: rewrite(item.expression, all, active)
              }))
            }
          }
        }
      }
      case 'cast':
        return { ...value, expression: rewrite(value.expression, all, active) }
      case 'convert':
        return {
          ...value,
          expression: rewrite(value.expression, all, active),
          ...value.style === undefined ? {} : { style: rewrite(value.style, all, active) }
        }
      case 'case':
        return {
          ...value,
          ...value.operand === undefined ? {} : { operand: rewrite(value.operand, all, active) },
          whens: value.whens.map(when => ({
            when: rewrite(when.when, all, active),
            then: rewrite(when.then, all, active)
          })),
          ...value.else_ === undefined ? {} : { else_: rewrite(value.else_, all, active) }
        }
      case 'in':
        return Array.isArray(value.values) ? {
          ...value,
          expression: rewrite(value.expression, all, active),
          values: value.values.map(item => rewrite(item, all, active))
        } : value
      case 'like':
        return {
          ...value,
          expression: rewrite(value.expression, all, active),
          pattern: rewrite(value.pattern, all, active),
          ...value.escape === undefined ? {} : { escape: rewrite(value.escape, all, active) }
        }
      case 'between':
        return {
          ...value,
          expression: rewrite(value.expression, all, active),
          low: rewrite(value.low, all, active),
          high: rewrite(value.high, all, active)
        }
      case 'isNull':
        return { ...value, expression: rewrite(value.expression, all, active) }
      default:
        return value
    }
  }

const containsGrouping =
  (value: Ast.Expression): boolean => {
    if (value.kind === 'call' &&
      (value.name[value.name.length - 1] ?? '').toLowerCase() === 'grouping') {
      return true
    }
    return JSON.stringify(value).toLowerCase().includes('"grouping"')
  }

/** @returns whether the SELECT needs branch expansion or GROUPING substitution. */
export const requiresExpansion =
  (select: Ast.Select): boolean =>
    select.groupBy !== undefined && (
      ordinary(select.groupBy) === undefined ||
      select.items.some(item => item.kind !== 'star' && containsGrouping(item.expression)) ||
      (select.having !== undefined && containsGrouping(select.having)) ||
      (select.orderBy?.some(item => containsGrouping(item.expression)) ?? false)
    )

/** @returns one ordinary GROUP BY branch with subtotal placeholders substituted. */
export const branch =
  (select: Ast.Select, active_: readonly Ast.Expression[]): Ast.Select => {
    const { groupBy: _groupBy, ...base } = select
    const allExpressions = expand(select.groupBy ?? []).flatMap(set => set)
    const all = new Set(allExpressions.map(key))
    const active = new Set(active_.map(key))
    return {
      ...base,
      items: select.items.map(item => {
        if (item.kind === 'star') {
          return item
        }
        const expression = rewrite(item.expression, all, active)
        const subtotalAlias = item.kind === 'expression' && item.alias === undefined &&
          item.expression.kind === 'column' && expression.kind === 'null' ?
          item.expression.name[item.expression.name.length - 1] :
          undefined
        return {
          ...item,
          expression,
          ...subtotalAlias === undefined ? {} : { alias: subtotalAlias }
        }
      }),
      ...active_.length === 0 ? {} : {
        groupBy: active_.map(expression => ({
          kind: 'expressions' as const,
          expressions: [ expression ]
        }))
      },
      ...select.having === undefined ? {} : { having: rewrite(select.having, all, active) }
    }
  }

const aggregateType =
  (name: string, input: TypeName.t | undefined): TypeName.t | undefined => {
    if (name === 'count') {
      return { name: 'int', args: [] }
    }
    if (name === 'count_big') {
      return { name: 'bigint', args: [] }
    }
    if (input === undefined || [ 'min', 'max' ].includes(name)) {
      return input
    }
    if ([ 'tinyint', 'smallint', 'int' ].includes(input.name)) {
      return { name: 'int', args: [] }
    }
    if ([ 'decimal', 'numeric' ].includes(input.name)) {
      const scale = typeof input.args[1] === 'number' ? input.args[1] : 0
      return {
        name: 'decimal',
        args: [ 38, name === 'avg' ? Math.max(6, scale) : scale ]
      }
    }
    if ([ 'real', 'float' ].includes(input.name)) {
      return { name: 'float', args: [] }
    }
    return input
  }

const selectedHint =
  (item: Ast.SelectItem, columns: readonly Ast.SourceColumn[]): ColumnHint | undefined => {
    if (item.kind !== 'expression') {
      return undefined
    }
    if (item.expression.kind === 'column') {
      const name = item.expression.name[item.expression.name.length - 1]?.toLowerCase()
      const column = columns.find(candidate => candidate.name.toLowerCase() === name)
      return column?.type === undefined ? undefined : {
        name: item.alias ?? column.name,
        type: column.type,
        nullable: true
      }
    }
    if (item.expression.kind !== 'call') {
      return undefined
    }
    const name = (item.expression.name[item.expression.name.length - 1] ?? '').toLowerCase()
    if (name === 'grouping') {
      return {
        name: item.alias ?? '',
        type: { name: 'tinyint', args: [] },
        nullable: false
      }
    }
    if (!aggregateNames.has(name)) {
      return undefined
    }
    const argument = item.expression.args[0]
    const input = argument?.kind === 'column' ?
      columns.find(column => column.name.toLowerCase() ===
        argument.name[argument.name.length - 1]?.toLowerCase())?.type :
      undefined
    const type = aggregateType(name, input)
    return type === undefined ? undefined : {
      name: item.alias ?? '',
      type,
      nullable: ![ 'count', 'count_big' ].includes(name)
    }
  }

/** @returns stable output metadata for a simple advanced grouping SELECT. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    if (!requiresExpansion(select) || select.from?.kind !== 'table' ||
      select.from.columns === undefined) {
      return undefined
    }
    const hints = select.items.map(item => selectedHint(item, select.from?.kind === 'table' ?
      select.from.columns ?? [] : []))
    return hints.some(hint => hint === undefined) ? undefined : hints as readonly ColumnHint[]
  }
