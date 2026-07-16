import * as Context from './context.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

export type DecimalType = {
  readonly precision: number,
  readonly scale: number
}

const declared =
  (type: TypeName.t): DecimalType | undefined => {
    switch (type.name) {
      case 'decimal':
      case 'numeric':
      case 'dec':
        return {
          precision: typeof type.args[0] === 'number' ? type.args[0] : 18,
          scale: typeof type.args[1] === 'number' ? type.args[1] : 0
        }
      case 'money':
        return { precision: 19, scale: 4 }
      case 'smallmoney':
        return { precision: 10, scale: 4 }
      default:
        return undefined
    }
  }

const literal =
  (value: string): DecimalType => {
    const unsigned = value.replace(/^[+-]/, '')
    const exponentAt = unsigned.search(/e/i)
    const plain = exponentAt < 0 ? unsigned : unsigned.slice(0, exponentAt)
    const exponent = exponentAt < 0 ? 0 : Number(unsigned.slice(exponentAt + 1))
    const [ whole = '', fraction = '' ] = plain.split('.')
    const significantWhole = whole.replace(/^0+/, '')
    const scale = Math.max(0, fraction.length - exponent)
    const integral = Math.max(0, significantWhole.length + exponent)
    return { precision: Math.max(1, integral + scale), scale }
  }

const integer =
  (type: TypeName.t): DecimalType | undefined => {
    switch (type.name) {
      case 'tinyint': return { precision: 3, scale: 0 }
      case 'smallint': return { precision: 5, scale: 0 }
      case 'int':
      case 'integer': return { precision: 10, scale: 0 }
      case 'bigint': return { precision: 19, scale: 0 }
      default: return undefined
    }
  }

const reduced =
  ({ precision, scale }: DecimalType, multiplicationOrDivision = false): DecimalType => {
    if (precision <= 38) {
      return { precision, scale }
    }
    const integral = precision - scale
    if (multiplicationOrDivision && integral > 32) {
      return { precision: 38, scale: scale < 6 ? scale : 6 }
    }
    return { precision: 38, scale: Math.max(0, Math.min(scale, 38 - integral)) }
  }

/** SQL Server precision/scale derivation for a decimal binary operator. */
export const resultType =
  (operator: string, left: DecimalType, right: DecimalType): DecimalType => {
    const a = left
    const b = right
    switch (operator) {
      case '+':
      case '-': {
        const scale = Math.max(a.scale, b.scale)
        return reduced({ precision: Math.max(a.precision - a.scale, b.precision - b.scale) + scale + 1, scale })
      }
      case '*':
        return reduced(
          { precision: a.precision + b.precision + 1, scale: a.scale + b.scale }, true)
      case '/': {
        const scale = Math.max(6, a.scale + b.precision + 1)
        return reduced({ precision: a.precision - a.scale + b.scale + scale, scale }, true)
      }
      case '%': {
        const scale = Math.max(a.scale, b.scale)
        return reduced({ precision: Math.min(a.precision - a.scale, b.precision - b.scale) + scale, scale })
      }
      default:
        return a
    }
  }

/** @returns exact numeric shape, including integer operands promoted for decimal arithmetic. */
export const numericType =
  (ctx: Context.t, value: Ast.Expression): DecimalType | undefined => {
    switch (value.kind) {
      case 'number':
        return value.value.includes('.') || /e/i.test(value.value) ? literal(value.value) :
          Number(value.value) >= -2147483648 && Number(value.value) <= 2147483647 ?
            { precision: 10, scale: 0 } : { precision: 19, scale: 0 }
      case 'cast':
      case 'convert':
        return declared(value.type) ?? integer(value.type)
      case 'column': {
        const type = Context.columnType(ctx, value.name)
        return type === undefined ? undefined : declared(type) ?? integer(type)
      }
      case 'unary':
        return numericType(ctx, value.operand)
      case 'collate':
        return numericType(ctx, value.expression)
      case 'binaryOp': {
        const left = numericType(ctx, value.left)
        const right = numericType(ctx, value.right)
        if (left === undefined || right === undefined ||
          ![ '+', '-', '*', '/', '%' ].includes(value.operator)) {
          return undefined
        }
        const decimal = typeOf(ctx, value.left) !== undefined || typeOf(ctx, value.right) !== undefined
        return decimal ? resultType(value.operator, left, right) : undefined
      }
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
        if (input === undefined) {
          return undefined
        }
        return name === 'sum' ? { precision: 38, scale: input.scale } :
          name === 'avg' ? { precision: 38, scale: Math.max(6, input.scale) } :
            name === 'min' || name === 'max' ? input : undefined
      }
      default:
        return undefined
    }
  }

/** @returns type only when the expression's result is DECIMAL/NUMERIC. */
export const typeOf =
  (ctx: Context.t, value: Ast.Expression): DecimalType | undefined => {
    if (value.kind === 'cast' || value.kind === 'convert') {
      return declared(value.type)
    }
    if (value.kind === 'number' && (value.value.includes('.') || /e/i.test(value.value))) {
      return literal(value.value)
    }
    if (value.kind === 'column') {
      const type = Context.columnType(ctx, value.name)
      return type === undefined ? undefined : declared(type)
    }
    if (value.kind === 'unary') {
      return typeOf(ctx, value.operand)
    }
    if (value.kind === 'collate') {
      return typeOf(ctx, value.expression)
    }
    if (value.kind === 'binaryOp' || value.kind === 'call') {
      return numericType(ctx, value)
    }
    return undefined
  }

const nameOf =
  (item: Ast.SelectItem & { kind: 'expression' }): string =>
    item.alias ?? (item.expression.kind === 'column' ?
      item.expression.name[item.expression.name.length - 1] ?? '' : '')

const hintType =
  (ctx: Context.t, value: Ast.Expression): TypeName.t | undefined => {
    const decimal = typeOf(ctx, value)
    if (decimal !== undefined) {
      return { name: 'decimal', args: [ decimal.precision, decimal.scale ] }
    }
    switch (value.kind) {
      case 'null':
        return { name: 'nvarchar', args: [ 1 ] }
      case 'string':
        return { name: 'nvarchar', args: [ Math.max(1, value.value.length) ] }
      case 'number':
        return {
          name: Number(value.value) >= -2147483648 && Number(value.value) <= 2147483647 ? 'int' : 'bigint',
          args: []
        }
      case 'cast':
      case 'convert':
        return value.type
      case 'column':
        return Context.columnType(ctx, value.name)
      default:
        return undefined
    }
  }

/** Exact-decimal result metadata when every projected column has a known shape. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    const ctx = Context.of()
    return Context.withSourceTypes(ctx, select.from, () => {
      let hasDecimal = false
      const hints = select.items.map(item => {
        if (item.kind !== 'expression') {
          return undefined
        }
        const exact = typeOf(ctx, item.expression)
        hasDecimal ||= exact !== undefined
        const type = hintType(ctx, item.expression)
        return type === undefined ? undefined : {
          name: nameOf(item),
          type,
          nullable: item.expression.kind === 'null'
        }
      })
      return !hasDecimal || hints.some(hint => hint === undefined) ?
        undefined : hints as readonly ColumnHint[]
    })
  }
