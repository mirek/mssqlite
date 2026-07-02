import * as Context from './context.ts'
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
    const inner = expression(ctx, expression_.expression)
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
          return `(${left} + ${right})`
        }
        return `mssqlite_add(${left}, ${right})`
      }
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

/** @returns SQLite rendering of a T-SQL expression, recording variables in `ctx`. */
export const expression =
  (ctx: Context.t, expression_: Ast.Expression): string => {
    switch (expression_.kind) {
      case 'null':
        return 'NULL'
      case 'default':
        return unsupported('DEFAULT is only valid in INSERT column lists.')
      case 'number':
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
      case 'unary':
        switch (expression_.operator) {
          case 'not':
            return `(NOT ${expression(ctx, expression_.operand)})`
          default:
            return `(${expression_.operator}${expression(ctx, expression_.operand)})`
        }
      case 'binaryOp':
        return binaryOp(ctx, expression_)
      case 'call': {
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
        const values = Array.isArray(expression_.values) ?
          expression_.values.map(value => expression(ctx, value)).join(', ') :
          subquery(ctx, expression_.values as Ast.Select)
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
      }
      case 'like': {
        const escape = expression_.escape === undefined ?
          '' :
          ` ESCAPE ${expression(ctx, expression_.escape)}`
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT LIKE' : 'LIKE'} ${expression(ctx, expression_.pattern)}${escape})`
      }
      case 'between':
        return `(${expression(ctx, expression_.expression)} ${expression_.negated ? 'NOT BETWEEN' : 'BETWEEN'} ${expression(ctx, expression_.low)} AND ${expression(ctx, expression_.high)})`
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
