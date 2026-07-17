import * as Context from './context.ts'
import * as Collation from './collation.ts'
import * as Character from './character.ts'
import * as Decimal from './decimal.ts'
import * as DateTimeOffset from './datetimeoffset.ts'
import * as Implicit from './implicit.ts'
import * as Quote from './quote.ts'
import * as Type from './type.ts'
import call, { convertStyle } from './functions.ts'
import infer from './infer.ts'
import { unsupported } from './error.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'

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

const firstProjectionType =
  (ctx: Context.t, select: Ast.Select): TypeName.t | undefined =>
    Context.withSourceTypes(ctx, select.from, () => {
      const item = select.items[0]
      return item?.kind === 'expression' ? Implicit.typeOf(ctx, item.expression) : undefined
    })

const convertedProjection =
  (ctx: Context.t, select: Ast.Select, target: TypeName.t | undefined): Ast.Select => {
    const item = select.items[0]
    const source = firstProjectionType(ctx, select)
    if (target === undefined || source === undefined || item?.kind !== 'expression') {
      return select
    }
    return {
      ...select,
      items: [
        { ...item, expression: Implicit.coerce(item.expression, source, target) },
        ...select.items.slice(1)
      ]
    }
  }

const numberSourceType =
  (value: string): TypeName.t => {
    if (value.includes('.') || /e/i.test(value)) {
      return { name: 'decimal', args: [] }
    }
    const integer = BigInt(value)
    return integer >= -2147483648n && integer <= 2147483647n ?
      { name: 'int', args: [] } : { name: 'decimal', args: [] }
  }

const cast =
  (ctx: Context.t, expression_: Ast.Expression & { kind: 'cast' | 'convert' }): string => {
    const source = expression_.expression
    const sourceType = source.kind === 'cast' || source.kind === 'convert' ? source.type :
      source.kind === 'column' ? Context.columnType(ctx, source.name) :
        source.kind === 'unary' && source.operand.kind === 'number' ? numberSourceType(source.operand.value) :
          source.kind === 'number' ? numberSourceType(source.value) :
            source.kind === 'string' ? {
              name: source.national ? 'nvarchar' : 'varchar', args: [ Math.max(1, source.value.length) ]
            } :
              source.kind === 'binary' ? { name: 'varbinary', args: [ Math.ceil((source.value.length - 2) / 2) ] } :
                undefined
    const signedLiteral = source.kind === 'unary' && [ '+', '-' ].includes(source.operator) &&
      source.operand.kind === 'number' ? `${source.operator}${source.operand.value}` : undefined
    const rendered = source.kind === 'number' ? Quote.string(source.value) :
      signedLiteral === undefined ? expression(ctx, source) : Quote.string(signedLiteral)
    const inner = sourceType !== undefined && Type.category(sourceType) === 'variant' ?
      `mssqlite_variant_unpack(${rendered})` : rendered
    if (Type.category(expression_.type) === 'variant') {
      if (sourceType !== undefined && Type.category(sourceType) === 'variant') {
        return rendered
      }
      const base = sourceType?.name ?? ''
      const first = typeof sourceType?.args[0] === 'number' ? sourceType.args[0] : -1
      const second = typeof sourceType?.args[1] === 'number' ? sourceType.args[1] : -1
      return `mssqlite_variant_pack(${rendered}, ${Quote.string(base)}, ${first}, ${second})`
    }
    if (Type.category(expression_.type) === 'udt') {
      return `mssqlite_udt_cast(${inner}, ${Quote.string(expression_.type.name)}, ` +
        `${expression_.try_ ? 1 : 0})`
    }
    if (Type.category(expression_.type) === 'xml') {
      return `mssqlite_xml_cast(${inner}, ${expression_.try_ ? 1 : 0})`
    }
    if (expression_.kind === 'convert' && expression_.style !== undefined) {
      const style = expression_.style.kind === 'number' ? Number(expression_.style.value) : undefined
      const format = style === undefined ? undefined : convertStyle(style)
      if (format !== undefined && (Type.category(expression_.type) === 'text' || Type.category(expression_.type) === 'ntext')) {
        return Character.cast(`strftime('${format}', ${inner})`, expression_.type, expression_.try_)
      }
    }
    if (Character.family(expression_.type) !== undefined) {
      return Character.cast(inner, expression_.type, expression_.try_)
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

const implicitCast =
  (ctx: Context.t, value: Ast.Expression, target: TypeName.t): string => {
    const source = Implicit.typeOf(ctx, value)
    const rendered = expression(ctx, value)
    if (source === undefined || Implicit.hasType(ctx, value, target)) {
      return rendered
    }
    return expression(ctx, Implicit.coerce(value, source, target))
  }

const coerced =
  (ctx: Context.t, value: Ast.Expression, target: TypeName.t | undefined): string =>
    target === undefined || value.kind === 'null' ? expression(ctx, value) : implicitCast(ctx, value, target)

const opaqueCategory =
  (ctx: Context.t, value: Ast.Expression): Type.Category | undefined => {
    const type = value.kind === 'column' ? Context.columnType(ctx, value.name) :
      value.kind === 'cast' || value.kind === 'convert' ? value.type : undefined
    const category = type === undefined ? undefined : Type.category(type)
    return category === 'variant' || category === 'xml' || category === 'udt' ? category : undefined
  }

const binaryOp =
  (ctx: Context.t, expression_: Ast.Expression & { kind: 'binaryOp' }): string => {
    const opaque = opaqueCategory(ctx, expression_.left) ?? opaqueCategory(ctx, expression_.right)
    if (opaque !== undefined) {
      if (opaque === 'xml') {
        const left = Implicit.typeOf(ctx, expression_.left)?.name ?? 'xml'
        const right = Implicit.typeOf(ctx, expression_.right)?.name ?? 'xml'
        const message = `The data types ${left} and ${right} are incompatible in the ` +
          `${expression_.operator === '=' ? 'equal to' : expression_.operator} operator.`
        return `mssqlite_implicit_error(402, ${Quote.string(message)})`
      }
      return unsupported(`Operator '${expression_.operator}' is not supported for ${opaque} values.`)
    }
    const common = Implicit.common(ctx, [ expression_.left, expression_.right ])
    const originalLeftNumeric = Decimal.numericType(ctx, expression_.left)
    const originalRightNumeric = Decimal.numericType(ctx, expression_.right)
    const exactPair = originalLeftNumeric !== undefined && originalRightNumeric !== undefined &&
      (Decimal.typeOf(ctx, expression_.left) !== undefined ||
        Decimal.typeOf(ctx, expression_.right) !== undefined)
    const left = exactPair ? expression(ctx, expression_.left) : coerced(ctx, expression_.left, common)
    const right = exactPair ? expression(ctx, expression_.right) : coerced(ctx, expression_.right, common)
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
    const textual = (common !== undefined && [ 'text', 'ntext' ].includes(Type.category(common) ?? '')) ||
      expression_.left.kind === 'collate' || expression_.right.kind === 'collate'
    const leftCollation = textual ? Collation.ofExpression(ctx, expression_.left) : undefined
    const rightCollation = textual ? Collation.ofExpression(ctx, expression_.right) : undefined
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
    const commonDecimal = common === undefined ? undefined : Decimal.shapeOf(common)
    const leftNumeric = originalLeftNumeric ?? commonDecimal
    const rightNumeric = originalRightNumeric ?? commonDecimal
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
    const arithmetic = [ '+', '-', '*', '/', '%' ].includes(expression_.operator)
    const commonCategory = common === undefined ? undefined : Type.category(common)
    if (arithmetic && expression_.operator === '+' && commonCategory === 'blob') {
      return `mssqlite_implicit_binary_concat(${left}, ${right})`
    }
    if (arithmetic && commonCategory !== undefined &&
      ![ 'integer', 'real', 'decimal' ].includes(commonCategory) &&
      !(expression_.operator === '+' && [ 'text', 'ntext' ].includes(commonCategory))) {
      const leftType = Implicit.typeOf(ctx, expression_.left)?.name ?? common?.name ?? 'unknown'
      const rightType = Implicit.typeOf(ctx, expression_.right)?.name ?? common?.name ?? 'unknown'
      const operator = {
        '+': 'add', '-': 'subtract', '*': 'multiply', '/': 'divide', '%': 'modulo'
      }[expression_.operator] ?? expression_.operator
      const message = `The data types ${leftType} and ${rightType} are incompatible in the ${operator} operator.`
      return `mssqlite_implicit_error(402, ${Quote.string(message)})`
    }
    const width = Math.max(integerWidth(expression_.left), integerWidth(expression_.right))
    switch (expression_.operator) {
      case '+': {
        const category = common === undefined ? undefined : Type.category(common)
        if (category === 'text' || category === 'ntext') {
          return `(${left} || ${right})`
        }
        if ([ 'integer', 'real', 'bit' ].includes(category ?? '')) {
          const fn = ctx.generated ? 'mssqlite_generated_arithmetic' : 'mssqlite_arithmetic'
          return `${fn}('+', ${left}, ${right}, ${width})`
        }
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
        if (callName === 'datalength' && expression_.args[0] !== undefined) {
          const value = expression_.args[0]
          const type = Character.typeOf(ctx, value)
          return type === undefined ?
            `mssqlite_datalength(${expression(ctx, value)})` :
            `mssqlite_datalength(${expression(ctx, value)}, ${Quote.string(type.name)})`
        }
        if (callName === 'isnull' && expression_.args.length === 2) {
          const type = Character.typeOf(ctx, expression_.args[0])
          if (type !== undefined) {
            const first = expression(ctx, expression_.args[0] ?? { kind: 'null' })
            const replacement = expression(ctx, expression_.args[1] ?? { kind: 'null' })
            return Character.cast(`ifnull(${first}, ${replacement})`, type, false, 1)
          }
        }
        if (expression_.name.length > 1 && [
          'query', 'value', 'exist', 'nodes', 'modify',
          'starea', 'stdistance', 'stintersects', 'stcontains', 'stastext', 'tostring',
          'getancestor', 'getdescendant', 'getlevel', 'isdescendantof'
        ].includes(callName ?? '')) {
          return unsupported(`Special-type method '${callName}' is not supported.`)
        }
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
        const resultType = Implicit.common(ctx, [
          ...expression_.whens.map(when => when.then),
          ...expression_.else_ === undefined ? [] : [ expression_.else_ ]
        ])
        const comparisonType = expression_.operand === undefined ? undefined :
          Implicit.common(ctx, [ expression_.operand, ...expression_.whens.map(when => when.when) ])
        const operand = expression_.operand === undefined ?
          '' :
          ` ${coerced(ctx, expression_.operand, comparisonType)}`
        const whens = expression_.whens
          .map(({ when, then }) =>
            `WHEN ${coerced(ctx, when, comparisonType)} THEN ${coerced(ctx, then, resultType)}`)
          .join(' ')
        const else_ = expression_.else_ === undefined ?
          '' :
          ` ELSE ${coerced(ctx, expression_.else_, resultType)}`
        return `(CASE${operand} ${whens}${else_} END)`
      }
      case 'in': {
        const opaque = opaqueCategory(ctx, expression_.expression)
        if (opaque !== undefined) {
          return unsupported(`Operator 'IN' is not supported for ${opaque} values.`)
        }
        const leftType = Implicit.typeOf(ctx, expression_.expression)
        const rightType = Array.isArray(expression_.values) ? undefined :
          firstProjectionType(ctx, expression_.values as Ast.Select)
        const common = Array.isArray(expression_.values) ?
          Implicit.common(ctx, [ expression_.expression, ...expression_.values ]) :
          Implicit.commonTypes([ leftType, rightType ].filter((type): type is TypeName.t => type !== undefined))
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
        const collation = common !== undefined &&
          [ 'text', 'ntext' ].includes(Type.category(common) ?? '') ?
          Collation.ofExpression(ctx, expression_.expression) : undefined
        if (collation !== undefined && Array.isArray(expression_.values)) {
          const left = Collation.expressionKey(expression(ctx, expression_.expression), collation)
          const values = expression_.values.map(value =>
            Collation.expressionKey(expression(ctx, value), collation)).join(', ')
          return `(${left} ${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
        }
        const values = Array.isArray(expression_.values) ?
          expression_.values.map(value => coerced(ctx, value, common)).join(', ') :
          subquery(ctx, convertedProjection(ctx, expression_.values as Ast.Select, common))
        return `(${coerced(ctx, expression_.expression, common)} ` +
          `${expression_.negated ? 'NOT IN' : 'IN'} (${values}))`
      }
      case 'like': {
        const opaque = opaqueCategory(ctx, expression_.expression)
        if (opaque !== undefined) {
          return unsupported(`Operator 'LIKE' is not supported for ${opaque} values.`)
        }
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
        const opaque = opaqueCategory(ctx, expression_.expression)
        if (opaque !== undefined) {
          return unsupported(`Operator 'BETWEEN' is not supported for ${opaque} values.`)
        }
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
        const common = Implicit.common(ctx, [ expression_.expression, expression_.low, expression_.high ])
        return `(${coerced(ctx, expression_.expression, common)} ` +
          `${expression_.negated ? 'NOT BETWEEN' : 'BETWEEN'} ` +
          `${coerced(ctx, expression_.low, common)} AND ${coerced(ctx, expression_.high, common)})`
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
