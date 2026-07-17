import * as Quote from './quote.ts'
import { unsupported } from './error.ts'
import type * as Context from './context.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

type PivotSource =
  Ast.TableSource & { kind: 'pivot' }

type UnpivotSource =
  Ast.TableSource & { kind: 'unpivot' }

type RenderExpression =
  (ctx: Context.t, expression: Ast.Expression) => string

type RenderSource =
  (ctx: Context.t, source: Ast.TableSource) => string

const itemName =
  (item: Ast.SelectItem): string | undefined =>
    item.kind === 'expression' ?
      item.alias ?? (item.expression.kind === 'column' ?
        item.expression.name[item.expression.name.length - 1] : undefined) :
      undefined

const expressionColumn =
  (source: readonly Ast.SourceColumn[], item: Ast.SelectItem & { kind: 'expression' }): Ast.SourceColumn | undefined => {
    const expression_ = item.expression
    if (expression_.kind === 'column') {
      const name = expression_.name[expression_.name.length - 1]?.toLowerCase()
      const column = source.find(candidate => candidate.name.toLowerCase() === name)
      return column === undefined ? undefined : { ...column, name: item.alias ?? column.name }
    }
    if (expression_.kind === 'cast' || expression_.kind === 'convert') {
      return item.alias === undefined ? undefined : { name: item.alias, type: expression_.type, nullable: true }
    }
    return item.alias === undefined ? undefined : { name: item.alias }
  }

const aggregateType =
  (aggregate: string, input: TypeName.t | undefined): TypeName.t | undefined => {
    if (aggregate === 'count') {
      return { name: 'int', args: [] }
    }
    if (input === undefined || [ 'min', 'max' ].includes(aggregate)) {
      return input
    }
    if ([ 'tinyint', 'smallint', 'int' ].includes(input.name)) {
      return { name: 'int', args: [] }
    }
    if (input.name === 'bigint') {
      return input
    }
    if ([ 'decimal', 'numeric' ].includes(input.name)) {
      const scale = typeof input.args[1] === 'number' ? input.args[1] : 0
      return {
        name: 'decimal',
        args: [ 38, aggregate === 'avg' ? Math.max(6, scale) : scale ]
      }
    }
    if ([ 'real', 'float' ].includes(input.name)) {
      return { name: 'float', args: [] }
    }
    return input
  }

const sameType =
  (left: TypeName.t, right: TypeName.t): boolean =>
    left.name === right.name && JSON.stringify(left.args) === JSON.stringify(right.args)

const sourceMetadata =
  (source: Ast.TableSource): readonly Ast.SourceColumn[] | undefined => {
    switch (source.kind) {
      case 'table':
        return source.columns
      case 'values':
        return source.columnMetadata
      case 'derived': {
        const input = source.select.from === undefined ? [] : sourceMetadata(source.select.from)
        if (input === undefined) {
          return undefined
        }
        const result: Ast.SourceColumn[] = []
        for (const item of source.select.items) {
          if (item.kind === 'star') {
            result.push(...input)
          } else if (item.kind === 'expression') {
            const column = expressionColumn(input, item)
            if (column === undefined) {
              return undefined
            }
            result.push(column)
          } else {
            return undefined
          }
        }
        return result
      }
      case 'pivot': {
        const input = sourceMetadata(source.source)
        if (input === undefined || source.aggregate.expression.kind !== 'column') {
          return undefined
        }
        const value = source.aggregate.expression.name[source.aggregate.expression.name.length - 1]?.toLowerCase()
        const pivot = source.pivotColumn[source.pivotColumn.length - 1]?.toLowerCase()
        const valueColumn = input.find(column => column.name.toLowerCase() === value)
        const aggregate = (source.aggregate.name[source.aggregate.name.length - 1] ?? '').toLowerCase()
        const type = aggregateType(aggregate, valueColumn?.type)
        return [
          ...input.filter(column => ![ value, pivot ].includes(column.name.toLowerCase())),
          ...source.values.map(name => ({
            name,
            ...type === undefined ? {} : { type },
            nullable: aggregate !== 'count'
          }))
        ]
      }
      case 'unpivot': {
        const input = sourceMetadata(source.source)
        if (input === undefined) {
          return undefined
        }
        const narrowed = new Set(source.columns.map(column => column.toLowerCase()))
        const valueColumns = input.filter(column => narrowed.has(column.name.toLowerCase()))
        const types = valueColumns.flatMap(column => column.type === undefined ? [] : [ column.type ])
        if (types.length === valueColumns.length && types.some(type => !sameType(type, types[0] ?? type))) {
          return unsupported('UNPIVOT input columns must have the same declared type.')
        }
        const type = types[0]
        const nameLength = Math.max(1, ...source.columns.map(column => column.length))
        return [
          ...input.filter(column => !narrowed.has(column.name.toLowerCase())),
          {
            name: source.pivotColumn,
            type: { name: 'nvarchar', args: [ nameLength ] },
            nullable: false
          },
          {
            name: source.valueColumn,
            ...type === undefined ? {} : { type },
            nullable: false
          }
        ]
      }
      case 'join': {
        const left = sourceMetadata(source.left)
        const right = sourceMetadata(source.right)
        return left === undefined || right === undefined ? undefined : [ ...left, ...right ]
      }
      default:
        return undefined
    }
  }

/** @returns exposed column names when statically knowable. */
export const columns =
  (source: Ast.TableSource): readonly string[] | undefined =>
    sourceMetadata(source)?.map(column => column.name) ?? (() => {
      if (source.kind !== 'derived') {
        return undefined
      }
      const names = source.select.items.map(item => itemName(item))
      return names.some(name => name === undefined) ? undefined : names as readonly string[]
    })()

const validateUnique =
  (names: readonly string[]): void => {
    const seen = new Set<string>()
    for (const name of names) {
      const key = name.toLowerCase()
      if (seen.has(key)) {
        unsupported(`Duplicate generated column name ${name}.`)
      }
      seen.add(key)
    }
  }

/** @returns conditional-aggregate rendering of PIVOT. */
export const pivot =
  (ctx: Context.t, source: PivotSource, renderSource: RenderSource, render: RenderExpression): string => {
    const input = columns(source.source)
    if (input === undefined || source.aggregate.expression.kind !== 'column') {
      return unsupported('PIVOT requires a source with statically known columns and a column value expression.')
    }
    const aggregate = (source.aggregate.name[source.aggregate.name.length - 1] ?? '').toLowerCase()
    if (![ 'sum', 'avg', 'min', 'max', 'count' ].includes(aggregate)) {
      return unsupported(`PIVOT aggregate ${aggregate} is not supported.`)
    }
    const valueName = source.aggregate.expression.name[source.aggregate.expression.name.length - 1]?.toLowerCase()
    const pivotName = source.pivotColumn[source.pivotColumn.length - 1]?.toLowerCase()
    if (valueName === undefined || pivotName === undefined ||
      !input.some(column => column.toLowerCase() === valueName) ||
      !input.some(column => column.toLowerCase() === pivotName)) {
      return unsupported('PIVOT value and pivot columns must exist in the input source.')
    }
    const grouping = input.filter(column => ![ valueName, pivotName ].includes(column.toLowerCase()))
    validateUnique([ ...grouping, ...source.values ])
    const key = render(ctx, { kind: 'column', name: source.pivotColumn })
    const value = render(ctx, source.aggregate.expression)
    const valueColumn = sourceMetadata(source.source)?.find(column =>
      column.name.toLowerCase() === valueName)
    const aggregateName = aggregate === 'avg' && valueColumn?.type !== undefined &&
      [ 'tinyint', 'smallint', 'int', 'bigint' ].includes(valueColumn.type.name) ?
      valueColumn.type.name === 'bigint' ? 'mssqlite_avg_bigint' : 'mssqlite_avg' : aggregate
    const aggregates = source.values.map(name =>
      `${aggregateName}(CASE WHEN ${key} = ${Quote.string(name)} THEN ${value} END) AS ${Quote.identifier(name)}`)
    const items = [ ...grouping.map(Quote.identifier), ...aggregates ]
    const groupBy = grouping.length === 0 ? '' : ` GROUP BY ${grouping.map(Quote.identifier).join(', ')}`
    return `(SELECT ${items.join(', ')} FROM ${renderSource(ctx, source.source)}${groupBy}) ` +
      `AS ${Quote.identifier(source.alias)}`
  }

/** @returns single-evaluation UNION ALL rendering of UNPIVOT. */
export const unpivot =
  (ctx: Context.t, source: UnpivotSource, renderSource: RenderSource): string => {
    const input = columns(source.source)
    if (input === undefined) {
      return unsupported('UNPIVOT requires a source with statically known columns.')
    }
    const byName = new Map(input.map(column => [ column.toLowerCase(), column ]))
    const narrowed = source.columns.map(column => byName.get(column.toLowerCase()))
    if (narrowed.some(column => column === undefined)) {
      return unsupported('Every UNPIVOT input column must exist in the source.')
    }
    const narrowedSet = new Set(source.columns.map(column => column.toLowerCase()))
    const grouping = input.filter(column => !narrowedSet.has(column.toLowerCase()))
    validateUnique([ ...grouping, source.pivotColumn, source.valueColumn ])
    const cte = Quote.identifier(`__mssqlite_unpivot_${ctx.nextSource++}`)
    const groupingSql = grouping.length === 0 ? '' : `${grouping.map(Quote.identifier).join(', ')}, `
    const terms = narrowed.map(column => {
      const name = column ?? ''
      return `SELECT ${groupingSql}${Quote.string(name)} AS ${Quote.identifier(source.pivotColumn)}, ` +
        `${Quote.identifier(name)} AS ${Quote.identifier(source.valueColumn)} FROM ${cte} ` +
        `WHERE ${Quote.identifier(name)} IS NOT NULL`
    })
    return `(WITH ${cte} AS MATERIALIZED (SELECT * FROM ${renderSource(ctx, source.source)}) ` +
      `${terms.join(' UNION ALL ')}) AS ${Quote.identifier(source.alias)}`
  }

/** @returns stable metadata for a simple SELECT over PIVOT or UNPIVOT. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    if ((select.from?.kind !== 'pivot' && select.from?.kind !== 'unpivot') || select.union !== undefined) {
      return undefined
    }
    const columns_ = sourceMetadata(select.from)
    if (columns_ === undefined || columns_.some(column => column.type === undefined)) {
      return undefined
    }
    const qualifier = select.from.alias.toLowerCase()
    const hints: ColumnHint[] = []
    for (const item of select.items) {
      if (item.kind === 'star') {
        const requested = item.qualifier?.[item.qualifier.length - 1]?.toLowerCase()
        if (requested !== undefined && requested !== qualifier) {
          return undefined
        }
        hints.push(...columns_.map(column => ({
          name: column.name,
          type: column.type ?? { name: 'nvarchar', args: [ 'max' ] },
          nullable: column.nullable ?? true
        })))
        continue
      }
      if (item.kind !== 'expression' || item.expression.kind !== 'column') {
        return undefined
      }
      const requested = item.expression.name.length > 1 ?
        item.expression.name[item.expression.name.length - 2]?.toLowerCase() :
        undefined
      if (requested !== undefined && requested !== qualifier) {
        return undefined
      }
      const name = item.expression.name[item.expression.name.length - 1]?.toLowerCase()
      const column = columns_.find(candidate => candidate.name.toLowerCase() === name)
      if (column?.type === undefined) {
        return undefined
      }
      hints.push({
        name: item.alias ?? column.name,
        type: column.type,
        nullable: column.nullable ?? true
      })
    }
    return hints
  }
