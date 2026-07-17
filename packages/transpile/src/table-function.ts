import * as Quote from './quote.ts'
import * as Type from './type.ts'
import { unsupported } from './error.ts'
import type * as Context from './context.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'

/** Declared result metadata known before SQLite prepares the statement. */
export type ColumnHint = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly nullable: boolean,
  readonly collation?: string
}

type FunctionSource =
  Ast.TableSource & { kind: 'function' }

type RenderExpression =
  (ctx: Context.t, expression: Ast.Expression) => string

const finalName =
  (name: Ast.QualifiedName): string =>
    (name[name.length - 1] ?? '').toLowerCase()

const expressionType =
  (value: Ast.Expression | undefined): TypeName.t => {
    if (value?.kind === 'cast' || value?.kind === 'convert') {
      return value.type
    }
    if (value?.kind === 'number') {
      if (value.value.includes('.')) {
        const [ whole = '', fraction = '' ] = value.value.split('.')
        return {
          name: 'decimal',
          args: [ Math.min(38, whole.replace('-', '').length + fraction.length), fraction.length ]
        }
      }
      const number = Number(value.value)
      return {
        name: Number.isSafeInteger(number) && number >= -2147483648 && number <= 2147483647 ?
          'int' :
          'bigint',
        args: []
      }
    }
    return { name: 'bigint', args: [] }
  }

const schema =
  (source_: FunctionSource): readonly ColumnHint[] => {
    let columns: readonly ColumnHint[]
    switch (finalName(source_.name)) {
      case 'string_split': {
        const input = source_.args[0]
        const textual = input?.kind === 'string' ?
          {
            name: input.national ? 'nvarchar' : 'varchar',
            args: [ Math.max(1, input.value.length) ]
          } :
          { name: 'nvarchar', args: [ 'max' ] }
        const ordinal = source_.args[2]
        const enabled = ordinal?.kind === 'number' && Number(ordinal.value) === 1
        columns = [
          { name: 'value', type: textual as TypeName.t, nullable: false },
          ...enabled ? [ {
            name: 'ordinal',
            type: { name: 'bigint', args: [] },
            nullable: false
          } ] : []
        ]
        break
      }
      case 'openjson': {
        const jsonColumns = source_.with ?? [
          { name: 'key', type: { name: 'nvarchar', args: [ 4000 ] }, asJson: false },
          { name: 'value', type: { name: 'nvarchar', args: [ 'max' ] }, asJson: false },
          { name: 'type', type: { name: 'int', args: [] }, asJson: false }
        ]
        columns = jsonColumns.map(column => ({ name: column.name, type: column.type, nullable: true }))
        break
      }
      case 'generate_series':
        columns = [ { name: 'value', type: expressionType(source_.args[0]), nullable: false } ]
        break
      default:
        return unsupported(`Unsupported table-valued function ${source_.name.join('.')}.`)
    }
    if (source_.columns === undefined) {
      return columns
    }
    if (source_.columns.length !== columns.length) {
      return unsupported(
        `Table alias for ${source_.name.join('.')} has ${source_.columns.length} columns; expected ${columns.length}.`)
    }
    return columns.map((column, index) => ({
      ...column,
      name: source_.columns?.[index] ?? column.name
    }))
  }

const alias =
  (source_: FunctionSource): string =>
    source_.alias ?? (source_.name[source_.name.length - 1] ?? '')

const stringSplit =
  (ctx: Context.t, source_: FunctionSource, render: RenderExpression): string => {
    if (source_.args.length < 2 || source_.args.length > 3 || source_.with !== undefined) {
      return unsupported('STRING_SPLIT expects two or three arguments and no WITH clause.')
    }
    const ordinal = source_.args[2]
    if (ordinal !== undefined &&
      !(ordinal.kind === 'null' || (ordinal.kind === 'number' && [ 0, 1 ].includes(Number(ordinal.value))))) {
      return unsupported('STRING_SPLIT enable_ordinal must be the constant 0, 1, or NULL.')
    }
    const input = render(ctx, source_.args[0] ?? { kind: 'null' })
    const separator = render(ctx, source_.args[1] ?? { kind: 'null' })
    const enabled = ordinal?.kind === 'number' && Number(ordinal.value) === 1
    const columns = schema(source_)
    const select = [
      `CAST("value" AS TEXT) AS ${Quote.identifier(columns[0]?.name ?? 'value')}`,
      ...enabled ? [
        `CAST("key" + 1 AS INTEGER) AS ${Quote.identifier(columns[1]?.name ?? 'ordinal')}`
      ] : []
    ].join(', ')
    return `(SELECT ${select} FROM json_each(mssqlite_string_split(${input}, ${separator}))) ` +
      `AS ${Quote.identifier(alias(source_))}`
  }

const openJson =
  (ctx: Context.t, source_: FunctionSource, render: RenderExpression): string => {
    if (source_.args.length < 1 || source_.args.length > 2) {
      return unsupported('OPENJSON expects one or two arguments.')
    }
    const at = `__mssqlite_openjson_${ctx.nextSource++}`
    const json = render(ctx, source_.args[0] ?? { kind: 'null' })
    const path = source_.args[1] === undefined ? Quote.string('$') : render(ctx, source_.args[1])
    const columns = schema(source_)
    let select: string
    let each: string
    if (source_.with === undefined) {
      each = `json_each(mssqlite_openjson_rows(${json}, ${path})) AS ${Quote.identifier(at)}`
      const names = columns.map(column => Quote.identifier(column.name))
      select = [
        `json_extract(${Quote.identifier(at)}."value", '$.key') AS ${names[0] ?? Quote.identifier('key')}`,
        `json_extract(${Quote.identifier(at)}."value", '$.value') AS ${names[1] ?? Quote.identifier('value')}`,
        `json_extract(${Quote.identifier(at)}."value", '$.type') AS ${names[2] ?? Quote.identifier('type')}`
      ].join(', ')
    } else {
      each = `json_each(mssqlite_openjson_sources(${json}, ${path})) AS ${Quote.identifier(at)}`
      select = source_.with.map((column, index) => {
        const columnPath = column.path ?? `$."${column.name.replaceAll('"', '\\"')}"`
        const pathSql = Quote.string(columnPath)
        const extracted = `mssqlite_openjson_column(${Quote.identifier(at)}."value", ` +
          `${pathSql}, ${column.asJson ? 1 : 0})`
        return `CAST(${extracted} AS ${Type.castType(column.type)}) AS ` +
          Quote.identifier(columns[index]?.name ?? column.name)
      }).join(', ')
    }
    return `(SELECT ${select} FROM ${each}) AS ${Quote.identifier(alias(source_))}`
  }

const openJsonColumnExpression =
  (table: string, column: NonNullable<FunctionSource['with']>[number]): string => {
    const columnPath = column.path ?? `$."${column.name.replaceAll('"', '\\"')}"`
    const extracted = `mssqlite_openjson_column(${table}."value", ` +
      `${Quote.string(columnPath)}, ${column.asJson ? 1 : 0})`
    return `CAST(${extracted} AS ${Type.castType(column.type)})`
  }

const generateSeries =
  (ctx: Context.t, source_: FunctionSource, render: RenderExpression): string => {
    if (source_.args.length < 2 || source_.args.length > 3 || source_.with !== undefined) {
      return unsupported('GENERATE_SERIES expects two or three arguments and no WITH clause.')
    }
    if (source_.args[2]?.kind === 'number' && Number(source_.args[2].value) === 0) {
      return unsupported('GENERATE_SERIES step cannot be zero.')
    }
    const start = render(ctx, source_.args[0] ?? { kind: 'null' })
    const stop = render(ctx, source_.args[1] ?? { kind: 'null' })
    const stepArg = source_.args[2] === undefined ? 'NULL' : render(ctx, source_.args[2])
    const step = `mssqlite_series_step(${start}, ${stop}, ${stepArg})`
    const cte = Quote.identifier(`__mssqlite_series_${ctx.nextSource++}`)
    const output = Quote.identifier(schema(source_)[0]?.name ?? 'value')
    return `(WITH RECURSIVE ${cte}("value", "stop", "step") AS (` +
      `SELECT ${start}, ${stop}, ${step} WHERE ${start} IS NOT NULL AND ${stop} IS NOT NULL ` +
      `AND ((${step}) > 0 AND ${start} <= ${stop} OR (${step}) < 0 AND ${start} >= ${stop}) ` +
      `UNION ALL SELECT "value" + "step", "stop", "step" FROM ${cte} ` +
      'WHERE ("step" > 0 AND "value" + "step" <= "stop") ' +
      'OR ("step" < 0 AND "value" + "step" >= "stop")) ' +
      `SELECT "value" AS ${output} FROM ${cte}) AS ${Quote.identifier(alias(source_))}`
  }

/** @returns SQLite derived-table rendering of a built-in table function. */
export const source =
  (ctx: Context.t, source_: FunctionSource, render: RenderExpression): string => {
    switch (finalName(source_.name)) {
      case 'string_split':
        return stringSplit(ctx, source_, render)
      case 'openjson':
        return openJson(ctx, source_, render)
      case 'generate_series':
        return generateSeries(ctx, source_, render)
      default:
        return unsupported(`Unsupported table-valued function ${source_.name.join('.')}.`)
    }
  }

/** @returns directly lateral SQLite source for APPLY-compatible TVF shapes. */
export const applySource =
  (ctx: Context.t, source_: FunctionSource, render: RenderExpression): string => {
    const name = finalName(source_.name)
    if (name === 'openjson' && source_.args.length >= 1 && source_.args.length <= 2) {
      const json = render(ctx, source_.args[0] ?? { kind: 'null' })
      const path = source_.args[1] === undefined ? Quote.string('$') : render(ctx, source_.args[1])
      const adapter = source_.with === undefined ? 'mssqlite_openjson_rows' : 'mssqlite_openjson_sources'
      return `json_each(${adapter}(${json}, ${path})) AS ${Quote.identifier(alias(source_))}`
    }
    if (name !== 'string_split' || source_.args.length !== 2 ||
      source_.with !== undefined || source_.columns !== undefined) {
      return unsupported('Correlated APPLY supports OPENJSON or two-argument STRING_SPLIT ' +
        'without a column alias list.')
    }
    const input = render(ctx, source_.args[0] ?? { kind: 'null' })
    const separator = render(ctx, source_.args[1] ?? { kind: 'null' })
    return `json_each(mssqlite_string_split(${input}, ${separator})) AS ${Quote.identifier(alias(source_))}`
  }

const applyExpressionEntries =
  (source_: Ast.TableSource | undefined): readonly (readonly [ string, string ])[] => {
    if (source_?.kind !== 'join') {
      return []
    }
    const nested = [ ...applyExpressionEntries(source_.left), ...applyExpressionEntries(source_.right) ]
    if (!source_.join.endsWith('Apply') || source_.right.kind !== 'function' ||
      finalName(source_.right.name) !== 'openjson') {
      return nested
    }
    const openJsonSource = source_.right
    const qualifier = alias(openJsonSource).toLowerCase()
    const table = Quote.identifier(alias(openJsonSource))
    const names = schema(openJsonSource).map(column => column.name)
    const expressions = openJsonSource.with === undefined ? [
      `json_extract(${table}."value", '$.key')`,
      `json_extract(${table}."value", '$.value')`,
      `json_extract(${table}."value", '$.type')`
    ] : openJsonSource.with.map(column => openJsonColumnExpression(table, column))
    return [
      ...nested,
      ...names.flatMap((name, index): readonly (readonly [ string, string ])[] => {
        const value = expressions[index]
        return value === undefined ? [] : [
          [ `${qualifier}.${name.toLowerCase()}`, value ],
          [ name.toLowerCase(), value ]
        ]
      })
    ]
  }

/** @returns column rewrites needed by lateral OPENJSON adapters under APPLY. */
export const applyColumnExpressions =
  (source_: Ast.TableSource | undefined): ReadonlyMap<string, string> =>
    new Map(applyExpressionEntries(source_))

/** @returns exact output hints for a simple SELECT over one table function. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    if (select.from?.kind !== 'function' || select.union !== undefined) {
      return undefined
    }
    const source_ = select.from
    const columns = schema(source_)
    const qualifier = alias(source_).toLowerCase()
    const hints: ColumnHint[] = []
    for (const item of select.items) {
      if (item.kind === 'star') {
        const requested = item.qualifier?.[item.qualifier.length - 1]?.toLowerCase()
        if (requested !== undefined && requested !== qualifier) {
          return undefined
        }
        hints.push(...columns)
        continue
      }
      if (item.kind !== 'expression' || item.expression.kind !== 'column') {
        return undefined
      }
      const name = item.expression.name[item.expression.name.length - 1]?.toLowerCase() ?? ''
      const requested = item.expression.name.length > 1 ?
        item.expression.name[item.expression.name.length - 2]?.toLowerCase() :
        undefined
      if (requested !== undefined && requested !== qualifier) {
        return undefined
      }
      const column = columns.find(candidate => candidate.name.toLowerCase() === name)
      if (column === undefined) {
        return undefined
      }
      hints.push({ ...column, name: item.alias ?? column.name })
    }
    return hints
  }
