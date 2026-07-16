import * as Context from './context.ts'
import * as Decimal from './decimal.ts'
import * as Type from './type.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'

const integerType =
  (left: TypeName.t, right: TypeName.t): TypeName.t =>
    left.name === 'bigint' || right.name === 'bigint' ?
      { name: 'bigint', args: [] } : { name: 'int', args: [] }

const expressionType =
  (ctx: Context.t, value: Ast.Expression): TypeName.t => {
    const decimal = Decimal.typeOf(ctx, value)
    if (decimal !== undefined) {
      return { name: 'decimal', args: [ decimal.precision, decimal.scale ] }
    }
    switch (value.kind) {
      case 'null':
        return { name: 'sql_variant', args: [] }
      case 'number':
        return {
          name: Number(value.value) >= -2147483648 && Number(value.value) <= 2147483647 ? 'int' : 'bigint',
          args: []
        }
      case 'string':
        return { name: value.national ? 'nvarchar' : 'varchar', args: [ Math.max(1, value.value.length) ] }
      case 'binary':
        return { name: 'varbinary', args: [ Math.max(1, Math.ceil((value.value.length - 2) / 2)) ] }
      case 'column':
        return Context.columnType(ctx, value.name) ?? { name: 'sql_variant', args: [] }
      case 'cast':
      case 'convert':
        return value.type
      case 'unary':
        return expressionType(ctx, value.operand)
      case 'collate':
        return expressionType(ctx, value.expression)
      case 'binaryOp': {
        const left = expressionType(ctx, value.left)
        const right = expressionType(ctx, value.right)
        if (value.operator === '+' &&
          [ 'text', 'ntext' ].includes(Type.category(left) ?? '') &&
          [ 'text', 'ntext' ].includes(Type.category(right) ?? '')) {
          return { name: 'nvarchar', args: [ 'max' ] }
        }
        return Type.category(left) === 'integer' && Type.category(right) === 'integer' ?
          integerType(left, right) : { name: 'sql_variant', args: [] }
      }
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        if ([ 'len', 'datalength', 'charindex', 'patindex', 'datepart', 'datediff' ].includes(name ?? '')) {
          return { name: 'int', args: [] }
        }
        if ([ 'upper', 'lower', 'ltrim', 'rtrim', 'trim', 'replace', 'substring' ].includes(name ?? '')) {
          return value.args[0] === undefined ?
            { name: 'nvarchar', args: [ 'max' ] } : expressionType(ctx, value.args[0])
        }
        return { name: 'sql_variant', args: [] }
      }
      case 'case': {
        const first = value.whens[0]?.then ?? value.else_
        return first === undefined ? { name: 'sql_variant', args: [] } : expressionType(ctx, first)
      }
      default:
        return { name: 'sql_variant', args: [] }
    }
  }

/** Resolves computed result types from base and earlier computed columns. */
export const columns =
  (
    definitions: readonly Ast.ColumnDefinition[],
    existing: readonly Ast.SourceColumn[] = []
  ): readonly Ast.ColumnDefinition[] => {
    const resolved: Ast.ColumnDefinition[] = []
    for (const column of definitions) {
      if (column.computed === undefined) {
        resolved.push(column)
        continue
      }
      const source: Ast.TableSource = {
        kind: 'table',
        name: [ '__computed_source' ],
        columns: [
          ...existing,
          ...resolved.map(candidate => ({
            name: candidate.name,
            type: candidate.type,
            nullable: candidate.nullable !== false,
            ...candidate.collate === undefined ? {} : { collation: candidate.collate }
          }))
        ]
      }
      const ctx = Context.of()
      const type = Context.withSourceTypes(ctx, source, () =>
        expressionType(ctx, column.computed?.expression ?? { kind: 'null' }))
      resolved.push({ ...column, type })
    }
    return resolved
  }
