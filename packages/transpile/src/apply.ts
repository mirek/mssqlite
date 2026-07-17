import * as Quote from './quote.ts'
import * as TableFunction from './table-function.ts'
import * as Context from './context.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'

type DerivedSource =
  Ast.TableSource & { readonly kind: 'derived' }

type ValuesSource =
  Ast.TableSource & { readonly kind: 'values' }

type RenderSelect =
  (ctx: Context.t, select: Ast.Select) => string

type RenderValues =
  (ctx: Context.t, source: ValuesSource) => string

type PackedSource =
  DerivedSource | ValuesSource

const projectedName =
  (item: Ast.SelectItem): string | undefined =>
    item.kind !== 'expression' ? undefined : item.alias ??
      (item.expression.kind === 'column' ?
        item.expression.name[item.expression.name.length - 1] : undefined)

const inferredDerivedColumns =
  (source: DerivedSource): readonly Ast.SourceColumn[] =>
    source.select.items.flatMap((item, index): readonly Ast.SourceColumn[] => {
      if (item.kind === 'star') {
        const selected = source.select.from === undefined ? [] :
          selectedColumns(source.select.from, item.qualifier)
        return selected.map(value => value.column)
      }
      const name = projectedName(item)
      if (name === undefined) {
        return unsupported(
          `No column name was specified for column ${index + 1} of '${source.alias}'.`)
      }
      return [ { name } ]
    })

const columnsOf =
  (source: Ast.TableSource): readonly Ast.SourceColumn[] => {
    switch (source.kind) {
      case 'table':
      case 'derived':
        return source.columns ?? (source.kind === 'derived' ? inferredDerivedColumns(source) : [])
      case 'values':
        return source.columnMetadata ?? source.columns?.map(name => ({ name })) ?? []
      case 'function':
        return TableFunction.schema(source)
      case 'join':
        return [ ...columnsOf(source.left), ...columnsOf(source.right) ]
      default:
        return []
    }
  }

const sourceAlias =
  (source: Ast.TableSource): string | undefined => {
    switch (source.kind) {
      case 'table':
      case 'function':
        return source.alias ?? source.name[source.name.length - 1]
      case 'derived':
      case 'values':
      case 'pivot':
      case 'unpivot':
        return source.alias
      default:
        return undefined
    }
  }

const selectedColumns =
  (source: Ast.TableSource, qualifier: Ast.QualifiedName | undefined): readonly {
    readonly alias: string,
    readonly column: Ast.SourceColumn
  }[] => {
    if (source.kind === 'join') {
      return [
        ...selectedColumns(source.left, qualifier),
        ...selectedColumns(source.right, qualifier)
      ]
    }
    const alias = sourceAlias(source)
    const requested = qualifier?.[qualifier.length - 1]?.toLowerCase()
    if (alias === undefined || (requested !== undefined && alias.toLowerCase() !== requested)) {
      return []
    }
    return columnsOf(source).map(column => ({ alias, column }))
  }

const packedColumns =
  (source: PackedSource): readonly Ast.SourceColumn[] => {
    const columns = columnsOf(source)
    const names = new Set<string>()
    for (const column of columns) {
      const key = column.name.toLowerCase()
      if (names.has(key)) {
        return unsupported(`The column '${column.name}' was specified multiple times for '${source.alias}'.`)
      }
      names.add(key)
    }
    if (columns.length === 0) {
      return unsupported(`APPLY source '${source.alias}' has no named columns.`)
    }
    return columns
  }

const packedSelect =
  (ctx: Context.t, source: PackedSource, inner: string): string => {
    const columns = packedColumns(source)
    const row = Quote.identifier(`__mssqlite_apply_row_${ctx.nextSource++}`)
    const values = columns.map(column =>
      `mssqlite_apply_pack(${row}.${Quote.identifier(column.name)}, ` +
      `${Quote.string(column.type?.name ?? '')})`).join(', ')
    return 'json_each((SELECT mssqlite_apply_rows(COUNT(*), ' +
      `json_group_array(json_array(${values}))) FROM ` +
      `(SELECT * FROM ${inner} LIMIT 100001) AS ${row})) AS ${Quote.identifier(source.alias)}`
  }

const nativeColumnExpressions =
  (source: Ast.TableSource | undefined): ReadonlyMap<string, string> => {
    if (source === undefined) {
      return new Map()
    }
    const selected = selectedColumns(source, undefined)
    const counts = new Map<string, number>()
    selected.forEach(item => {
      const key = item.column.name.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    })
    return new Map(selected.flatMap(item => {
      const key = item.column.name.toLowerCase()
      const value = `${Quote.identifier(item.alias)}.${Quote.identifier(item.column.name)}`
      return [
        [ `${item.alias.toLowerCase()}.${key}`, value ] as const,
        ...counts.get(key) === 1 ? [ [ key, value ] as const ] : []
      ]
    }))
  }

/** Renders an arbitrary derived APPLY source through a correlated packed rowset. */
export const derivedSource =
  (ctx: Context.t, source: DerivedSource, render: RenderSelect): string =>
    packedSelect(ctx, source, `(${Context.withColumnExpressions(
      ctx, nativeColumnExpressions(source.select.from), () => render(ctx, source.select))})`)

/** Renders a VALUES APPLY source, including expressions correlated to its left input. */
export const valuesSource =
  (ctx: Context.t, source: ValuesSource, render: RenderValues): string =>
    packedSelect(ctx, source, render(ctx, source))

const packedApplySources =
  (source: Ast.TableSource | undefined): readonly PackedSource[] => {
    if (source?.kind !== 'join') {
      return []
    }
    return [
      ...packedApplySources(source.left),
      ...packedApplySources(source.right),
      ...source.join.endsWith('Apply') &&
        (source.right.kind === 'derived' || source.right.kind === 'values') ?
        [ source.right ] : []
    ]
  }

const hasRewrittenApply =
  (source: Ast.TableSource | undefined): boolean =>
    source?.kind === 'join' && (
      (source.join.endsWith('Apply') &&
        [ 'derived', 'values', 'function' ].includes(source.right.kind)) ||
      hasRewrittenApply(source.left) || hasRewrittenApply(source.right))

const expressionOf =
  (source: PackedSource, index: number): string =>
    `mssqlite_apply_unpack(json_extract(${Quote.identifier(source.alias)}."value", '$[${index}]'))`

/** Column rewrites that expose packed APPLY rows under their T-SQL names. */
export const columnExpressions =
  (source: Ast.TableSource | undefined): ReadonlyMap<string, string> => {
    const packed = packedApplySources(source)
    const allNames = source === undefined ? [] : selectedColumns(source, undefined)
      .map(item => item.column.name.toLowerCase())
    const counts = new Map<string, number>()
    allNames.forEach(name => counts.set(name, (counts.get(name) ?? 0) + 1))
    const entries = packed.flatMap(item => packedColumns(item).flatMap((column, index) => {
      const key = column.name.toLowerCase()
      const value = expressionOf(item, index)
      return [
        [ `${item.alias.toLowerCase()}.${key}`, value ] as const,
        ...counts.get(key) === 1 ? [ [ key, value ] as const ] : []
      ]
    }))
    return new Map(entries)
  }

/** Expands stars only when a packed APPLY source would otherwise expose json_each internals. */
export const expandStars =
  (source: Ast.TableSource | undefined, items: readonly Ast.SelectItem[]): readonly Ast.SelectItem[] => {
    if (source === undefined || !hasRewrittenApply(source)) {
      return items
    }
    return items.flatMap(item => {
      if (item.kind !== 'star') {
        return [ item ]
      }
      const selected = selectedColumns(source, item.qualifier)
      if (selected.length === 0) {
        return unsupported('SELECT * could not resolve APPLY source columns.')
      }
      return selected.map(({ alias, column }): Ast.SelectItem => ({
        kind: 'expression',
        expression: { kind: 'column', name: [ alias, column.name ] },
        alias: column.name
      }))
    })
  }
