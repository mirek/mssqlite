import * as Context from './context.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

/** @returns datetimeoffset scale when statically known. */
export const scaleOf =
  (ctx: Context.t, value: Ast.Expression): number | undefined => {
    if (value.kind === 'cast' || value.kind === 'convert') {
      return value.type.name === 'datetimeoffset' ?
        typeof value.type.args[0] === 'number' ? value.type.args[0] : 7 : undefined
    }
    if (value.kind === 'column') {
      const type = Context.columnType(ctx, value.name)
      return type?.name === 'datetimeoffset' ?
        typeof type.args[0] === 'number' ? type.args[0] : 7 : undefined
    }
    if (value.kind === 'collate') {
      return scaleOf(ctx, value.expression)
    }
    if (value.kind === 'call' && value.name[value.name.length - 1]?.toLowerCase() === 'dateadd') {
      return value.args[2] === undefined ? undefined : scaleOf(ctx, value.args[2])
    }
    return undefined
  }

export const key =
  (rendered: string): string =>
    `mssqlite_datetimeoffset_key(${rendered})`

const nameOf =
  (item: Ast.SelectItem & { kind: 'expression' }): string =>
    item.alias ?? (item.expression.kind === 'column' ?
      item.expression.name[item.expression.name.length - 1] ?? '' : '')

const hintType =
  (ctx: Context.t, value: Ast.Expression): TypeName.t | undefined => {
    const scale = scaleOf(ctx, value)
    if (scale !== undefined) {
      return { name: 'datetimeoffset', args: [ scale ] }
    }
    switch (value.kind) {
      case 'null':
        return { name: 'nvarchar', args: [ 1 ] }
      case 'string':
        return { name: 'nvarchar', args: [ Math.max(1, value.value.length) ] }
      case 'number':
        return {
          name: Number(value.value) >= -2147483648 && Number(value.value) <= 2147483647 ?
            'int' : 'bigint',
          args: []
        }
      case 'cast':
      case 'convert':
        return value.type
      case 'column':
        return Context.columnType(ctx, value.name)
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        return name === 'datediff' || name === 'datepart' ? { name: 'int', args: [] } :
          name === 'datename' ? { name: 'nvarchar', args: [ 4000 ] } : undefined
      }
      default:
        return undefined
    }
  }

/** datetimeoffset result metadata when every projected column has a known shape. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    const ctx = Context.of()
    return Context.withSourceTypes(ctx, select.from, () => {
      let hasDateTimeOffset = false
      const hints = select.items.map(item => {
        if (item.kind !== 'expression') {
          return undefined
        }
        hasDateTimeOffset ||= scaleOf(ctx, item.expression) !== undefined
        const type = hintType(ctx, item.expression)
        return type === undefined ? undefined : {
          name: nameOf(item),
          type,
          nullable: item.expression.kind === 'null' ||
            item.expression.kind === 'cast' || item.expression.kind === 'convert'
        }
      })
      return !hasDateTimeOffset || hints.some(hint => hint === undefined) ?
        undefined : hints as readonly ColumnHint[]
    })
  }
