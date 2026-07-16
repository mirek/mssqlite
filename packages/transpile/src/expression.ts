import * as Context from './context.ts'
import * as Collation from './collation.ts'
import * as Decimal from './decimal.ts'
import * as DateTimeOffset from './datetimeoffset.ts'
import * as Quote from './quote.ts'
import * as Type from './type.ts'
import call, { convertStyle } from './functions.ts'
import infer from './infer.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'

/** Renders a SELECT — injected by statement.ts to break the module cycle. */
let selectRender: ((ctx: Context.t, select: Ast.Select) => string) | undefined

/** Wires the SELECT renderer used for subqueries. */
export const useSelectRender =
  (render: (ctx: Context.t, select: Ast.Select) => string): void => {
    selectRender = render
  }

const subquery =
  (ctx: Context.t, select: Ast.Select): string =>
    selectRender === undefined ?
      unsupported('Select renderer not wired.') :
      selectRender(ctx, select)

const cast =
  (ctx: Context.t, expression_: Ast.Expression & { kind: 'cast' | 'convert' }): string => {
    const source = expression_.expression
    const signedLiteral = source.kind === 'unary' && [ '+', '-' ].includes(source.operator) &&
      source.operand.kind === 'number' ? `${source.operator}${source.operand.value}` : undefined
    const inner = source.kind === 'number' ? Quote.string(source.value) :
      signedLiteral === undefined ? expression(ctx, source) : Quote.string(signedLiteral)
    if (expression_.kind === 'convert' && expression_.style !== undefined) {
      const style = expression_.style.kind === 'number' ? Number(expression_.style.value) : undefined
      const format = style === undefined ? undefined : convertStyle(style)
      if (format !== undefined && (Type.category(expression_.type) === 'text' || Type.category(expression_.type) === 'ntext')) {
        const length = expression_.type.args[0]
        return typeof length === 'number' ?
          `substr(strftime('${format}', ${inner}), 1, ${length})` :
          `strftime('${format}', ${inner})`
      }
    }
    if (Type.category(expression_.type) === 'integer') {
      return `mssqlite_cast_integer(${inner}, ${Quote.string(expression_.type.name)}, ` +
        `${expression_.try_ ? 1 : 0})`
    }
    if (expression_.type.name === 'datetimeoffset') {
      const scale = typeof expression_.type.args[0] === 'number' ? expression_.type.args[0] : 7
      return `mssqlite_datetimeoffset_cast(${inner}, ${scale}, ${expression_.try_ ? 1 : 0})`
    }
    if (Type.category(expression_.type) === 'decimal') {
      const precision = typeof expression_.type.args[0] === 'number' ? expression_.type.args[0] : 18
      const scale = typeof expression_.type.args[1] === 'number' ? expression_.type.args[1] : 0
      return `mssqlite_decimal_cast(${inner}, ${precision}, ${scale}, ${expression_.try_ ? 1 : 0})`
    }
    switch (Type.category(expression_.type)) {
      case 'date':
        return `date(${inner})`
      case 'time':
        return `time(${inner})`
      case 'datetime':
        return `strftime('%Y-%m-%d %H:%M:%f', ${inner})`
      case 'bit':
        return `(CAST(${inner} AS NUMERIC) <> 0)`
      case 'guid':
        return `upper(CAST(${inner} AS TEXT))`
      default:
        return `CAST(${inner} AS ${Type.castType(expression_.type)})`
    }
  }

const binaryOp =
  (ctx: Context.t, expression_: Ast.Expression & { kind: 'binaryOp' }): string => {
    const left = expression(ctx, expression_.left)
    const right = expression(ctx, expression_.right)
    const leftOffset = DateTimeOffset.scaleOf(ctx, expression_.left)
    const rightOffset = DateTimeOffset.scaleOf(ctx, expression_.right)
    if ((leftOffset !== undefined || rightOffset !== undefined) &&
      [ '=', '<>', '!=', '<', '<=', '>', '>=', '!>', '!<' ].includes(expression_.operator)) {
      const scale = leftOffset ?? rightOffset ?? 7
      const a = leftOffset === undefined ? `mssqlite_datetimeoffset_cast(${left}, ${scale}, 0)` : left
      const b = rightOffset === undefined ? `mssqlite_datetimeoffset_cast(${right}, ${scale}, 0)` : right
      const operator = expression_.operator === '!>' ? '<=' : expression_.operator === '!<' ? '>=' :
        expression_.operator
      return `(${DateTimeOffset.key(a)} ${operator} ${DateTimeOffset.key(b)})`
    }
    const leftCollation = Collation.ofExpression(ctx, expression_.left)
    const rightCollation = Collation.ofExpression(ctx, expression_.right)
    if (leftCollation !== undefined && rightCollation !== undefined &&
      leftCollation !== rightCollation &&
      expression_.left.kind !== 'collate' && expression_.right.kind !== 'collate') {
      return unsupported(
        `Cannot resolve the collation conflict between '${leftCollation}' and '${rightCollation}'.`)
    }
    const collation = expression_.left.kind === 'collate' ? leftCollation :
      expression_.right.kind === 'collate' ? rightCollation : leftCollation ?? rightCollation
    if (collation !== undefined &&
      [ '=', '<>', '!=', '<', '<=', '>', '>=', '!>', '!<' ].includes(expression_.operator)) {
      const operator = expression_.operator === '!>' ? '<=' : expression_.operator === '!<' ? '>=' :
        expression_.operator
      return `(${Collation.expressionKey(left, collation)} ${operator} ` +
        `${Collation.expressionKey(right, collation)})`
    }
    const leftNumeric = Decimal.numericType(ctx, expression_.left)
    const rightNumeric = Decimal.numericType(ctx, expression_.right)
    const decimal = Decimal.typeOf(ctx, expression_.left) !== undefined ||
      Decimal.typeOf(ctx, expression_.right) !== undefined
    if (decimal && leftNumeric !== undefined && rightNumeric !== undefined) {
      if ([ '+', '-', '*', '/', '%' ].includes(expression_.operator)) {
        const result = Decimal.resultType(expression_.operator, leftNumeric, rightNumeric)
        const fn = ctx.generated ? 'mssqlite_decimal_generated_arithmetic' :
          'mssqlite_decimal_arithmetic'
        return `${fn}('${expression_.operator}', ${left}, ${right}, ` +
          `${leftNumeric.scale}, ${rightNumeric.scale}, ${result.precision}, ${result.scale})`
      }
      if ([ '=', '<>', '!=', '<', '<=', '>', '>=', '!>', '!<' ].includes(expression_.operator)) {
        const operator = expression_.operator === '!>' ? '<=' : expression_.operator === '!<' ? '>=' :
          expression_.operator
        return `(mssqlite_decimal_compare(${left}, ${right}, ${leftNumeric.scale}, ` +
          `${rightNumeric.scale}) ${operator} 0)`
      }
    }
    const width = Math.max(integerWidth(expression_.left), integerWidth(expression_.right))
    switch (expression_.operator) {
      case '+': {
        const leftType = infer(expression_.left)
        const rightType = infer(expression_.right)
        // T-SQL concatenates only when both sides are text; a text/number mix
        // converts the string to a number and adds. mssqlite_add resolves the
        // remaining unknown cases at runtime (concat two strings, else add).
        if (leftType === 'text' && rightType === 'text') {
          return `(${left} || ${right})`
        }
        if (leftType === 'number' && rightType === 'number') {
          const fn = ctx.generated ? 'mssqlite_generated_arithmetic' : 'mssqlite_arithmetic'
          return `${fn}('+', ${left}, ${right}, ${width})`
        }
        return `mssqlite_add(${left}, ${right})`
      }
      case '-':
      case '*':
      case '/':
      case '%':
        return `${ctx.generated ? 'mssqlite_generated_arithmetic' : 'mssqlite_arithmetic'}(` +
          `'${expression_.operator}', ${left}, ${right}, ${width})`
      case 'and':
        return `(${left} AND ${right})`
      case 'or':
        return `(${left} OR ${right})`
      case '^':
        // SQLite has no xor operator.
        return `((${left} | ${right}) - (${left} & ${right}))`
      case '!>':
        return `(${left} <= ${right})`
      case '!<':
        return `(${left} >= ${right})`
      default:
        return `(${left} ${expression_.operator} ${right})`
    }
  }

const integerWidth =
  (expression_: Ast.Expression): number => {
    switch (expression_.kind) {
      case 'number': {
        const value = Number(expression_.value)
        return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? 32 : 0
      }
      case 'cast':
      case 'convert':
        return expression_.type.name === 'bigint' ? 64 :
          Type.category(expression_.type) === 'integer' ? 32 : 0
      case 'unary':
        return integerWidth(expression_.operand)
      case 'binaryOp':
        return Math.max(integerWidth(expression_.left), integerWidth(expression_.right))
      default:
        return 0
    }
  }

/** @returns SQLite rendering of a T-SQL expression, recording variables in `ctx`. */
export const expression =
  (ctx: Context.t, expression_: Ast.Expression): string => {
    switch (expression_.kind) {
      case 'null':
        return 'NULL'
      case 'default':
        return unsupported('DEFAULT is only valid in INSERT column lists.')
      case 'number':
        if (expression_.value.includes('.') || /e/i.test(expression_.value)) {
          const type = Decimal.typeOf(ctx, expression_)
          return type === undefined ? expression_.value :
            `mssqlite_decimal_cast(${Quote.string(expression_.value)}, ${type.precision}, ${type.scale}, 0)`
        }
        return expression_.value
      case 'string':
        return Quote.string(expression_.value)
      case 'binary': {
        // SQLite blob literals need an even number of hex digits.
        const digits = expression_.value.slice(2)
        const hex = digits.length % 2 === 0 ? digits : `0${digits}`
        return `x'${hex}'`
      }
      case 'variable':
        return Context.parameter(ctx, expression_.name)
      case 'column':
        return Quote.columnName(expression_.name)
      case 'nextValue':
        return `mssqlite_next_value_for(${Quote.string(expression_.sequence.join('.'))})`
      case 'collate':
        return `(${expression(ctx, expression_.expression)} COLLATE ${Collation.sqlite(expression_.collation)})`
      case 'unary':
        if (expression_.operator === '-' && Decimal.typeOf(ctx, expression_.operand) !== undefined) {
          const type = Decimal.typeOf(ctx, expression_.operand)
          if (type !== undefined) {
            return `mssqlite_decimal_arithmetic('-', '0', ${expression(ctx, expression_.operand)}, ` +
              `0, ${type.scale}, ${type.precision}, ${type.scale})`
          }
        }
        switch (expression_.operator) {
          case 'not':
            return `(NOT ${expression(ctx, expression_.operand)})`
          default:
            return `(${expression_.operator}${expression(ctx, expression_.operand)})`
        }
      case 'binaryOp':
        return binaryOp(ctx, expression_)
      case 'call': {
        const callName = expression_.name[expression_.name.length - 1]?.toLowerCase()
        const input = expression_.args[0] === undefined ? undefined : Decimal.typeOf(ctx, expression_.args[0])
        if ([ 'sum', 'avg', 'min', 'max' ].includes(callName ?? '') && input !== undefined) {
          const output = Decimal.typeOf(ctx, expression_)
          const value = expression_.args[0]
          if (output !== undefined && value !== undefined) {
            return callName === 'min' || callName === 'max' ?
              `mssqlite_decimal_${callName}(${expression(ctx, value)}, ${input.scale})` :
              `mssqlite_decimal_${callName}(${expression(ctx, value)}, ${input.scale}, ` +
                `${output.precision}, ${output.scale})`
          }
        }
        const rendered = call(expression_, inner => expression(ctx, inner))
        if (expression_.distinct === true) {
          const name = rendered.slice(0, rendered.indexOf('('))
          const args = rendered.slice(rendered.indexOf('(') + 1)
          return `${name}(DISTINCT ${args}`
        }
        if (expression_.over !== undefined) {
          const partition = expression_.over.partitionBy.length > 0 ?
            `PARTITION BY ${expression_.over.partitionBy.map(inner => expression(ctx, inner)).join(', ')}` :
            ''
          const order = expression_.over.orderBy.length > 0 ?
            `ORDER BY ${expression_.over.orderBy
              .map(item => `${expression(ctx, item.expression)}${item.descending ? ' DESC' : ''}`)
              .join(', ')}` :
            ''
          return `${rendered} OVER (${[ partition, order ].filter(Boolean).join(' ')})`
        }
        return rendered
      }
      case 'cast':
      case 'convert':
        return cast(ctx, expression_)
      case 'case': {
        const operand = expression_.operand === undefined ?
          '' :
          ` ${expression(ctx, expression_.operand)}`
        const whens = expression_.whens
          .map(({ when, then }) =>
            `WHEN ${expression(ctx, when)} THEN ${expression(ctx, then)}`)
          .join(' ')
        const else_ = expression_.else_ === undefined ?
          '' :
          ` ELSE ${expression(ctx, expression_.else_)}`
        return `(CASE${operand} ${whens}${else_} END)`
      }
      case 'in': {
        const offsetScale = DateTimeOffset.scaleOf(ctx, expression_.expression) ??
          (Array.isArray(expression_.values) ? expression_.values
            .map(value => DateTimeOffset.scaleOf(ctx, value))
            .find(scale => scale !== undefined) : undefined)
        if (offsetScale !== undefined && Array.isArray(expression_.values)) {
          const offsetKey = (value: Ast.Expression): string => {
            const rendered = expression(ctx, value)
            const casted = DateTimeOffset.scaleOf(ctx, value) === undefined ?
              `mssqlite_datetimeoffset_cast(${rendered}, ${offsetScale}, 0)` : rendered
            return DateTimeOffset.key(casted)
          }
          const values = expression_.values.map(offsetKey).join(', ')
          return `(${offsetKey(expression_.expression)} ${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
        }
        const collation = Collation.ofExpression(ctx, expression_.expression)
        if (collation !== undefined && Array.isArray(expression_.values)) {
          const left = Collation.expressionKey(expression(ctx, expression_.expression), collation)
          const values = expression_.values.map(value =>
            Collation.expressionKey(expression(ctx, value), collation)).join(', ')
          return `(${left} ${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
        }
        const values = Array.isArray(expression_.values) ?
          expression_.values.map(value => expression(ctx, value)).join(', ') :
          subquery(ctx, expression_.values as Ast.Select)
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
      }
      case 'like': {
        const collation = Collation.ofExpression(ctx, expression_.expression) ??
          Collation.ofExpression(ctx, expression_.pattern)
        if (collation !== undefined && expression_.escape === undefined) {
          return `(${expression_.negated ? 'NOT ' : ''}mssqlite_collation_like(` +
            `${expression(ctx, expression_.expression)}, ${expression(ctx, expression_.pattern)}, ` +
            `'${collation}'))`
        }
        const escape = expression_.escape === undefined ?
          '' :
          ` ESCAPE ${expression(ctx, expression_.escape)}`
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT LIKE' : 'LIKE'} ${expression(ctx, expression_.pattern)}${escape})`
      }
      case 'between': {
        const scale = DateTimeOffset.scaleOf(ctx, expression_.expression) ??
          DateTimeOffset.scaleOf(ctx, expression_.low) ?? DateTimeOffset.scaleOf(ctx, expression_.high)
        if (scale !== undefined) {
          const offsetKey = (value: Ast.Expression): string => {
            const rendered = expression(ctx, value)
            const casted = DateTimeOffset.scaleOf(ctx, value) === undefined ?
              `mssqlite_datetimeoffset_cast(${rendered}, ${scale}, 0)` : rendered
            return DateTimeOffset.key(casted)
          }
          return `(${offsetKey(expression_.expression)} ${expression_.negated ? 'NOT BETWEEN' : 'BETWEEN'} ` +
            `${offsetKey(expression_.low)} AND ${offsetKey(expression_.high)})`
        }
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT BETWEEN' : 'BETWEEN'} ` +
          `${expression(ctx, expression_.low)} AND ${expression(ctx, expression_.high)})`
      }
      case 'isNull':
        return `(${expression(ctx, expression_.expression)} IS ${expression_.negated ? 'NOT ' : ''}NULL)`
      case 'exists':
        return `EXISTS (${subquery(ctx, expression_.select)})`
      case 'subquery':
        return `(${subquery(ctx, expression_.select)})`
      default:
        return unsupported('Unsupported expression.')
    }
  }

export default expression
