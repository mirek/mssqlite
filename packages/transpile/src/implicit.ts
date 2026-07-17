import * as Context from './context.ts'
import * as Type from './type.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

const aliases: Readonly<Record<string, string>> = {
  integer: 'int',
  dec: 'decimal',
  numeric: 'decimal',
  'double precision': 'float',
  character: 'char',
  'character varying': 'varchar',
  'national character': 'nchar',
  'national char': 'nchar',
  'national character varying': 'nvarchar',
  'national char varying': 'nvarchar',
  'national text': 'ntext',
  timestamp: 'rowversion'
}

// Lower number means higher SQL Server data-type precedence.
const precedence: Readonly<Record<string, number>> = {
  json: 1,
  sql_variant: 2,
  xml: 3,
  datetimeoffset: 4,
  datetime2: 5,
  datetime: 6,
  smalldatetime: 7,
  date: 8,
  time: 9,
  float: 10,
  real: 11,
  decimal: 12,
  money: 13,
  smallmoney: 14,
  bigint: 15,
  int: 16,
  smallint: 17,
  tinyint: 18,
  bit: 19,
  ntext: 20,
  text: 21,
  image: 22,
  rowversion: 23,
  uniqueidentifier: 24,
  nvarchar: 25,
  nchar: 26,
  varchar: 27,
  char: 28,
  varbinary: 29,
  binary: 30
}

const canonical =
  (name: string): string =>
    aliases[name] ?? name

const decimalLiteral =
  (value: string): TypeName.t => {
    const unsigned = value.replace(/^[+-]/, '')
    const exponentAt = unsigned.search(/e/i)
    const plain = exponentAt < 0 ? unsigned : unsigned.slice(0, exponentAt)
    const exponent = exponentAt < 0 ? 0 : Number(unsigned.slice(exponentAt + 1))
    const [ whole = '', fraction = '' ] = plain.split('.')
    const integral = Math.max(0, whole.replace(/^0+/, '').length + exponent)
    const scale = Math.max(0, fraction.length - exponent)
    return { name: 'decimal', args: [ Math.max(1, integral + scale), scale ] }
  }

/** @returns the statically known SQL type of an expression. */
export const typeOf =
  (ctx: Context.t, value: Ast.Expression): TypeName.t | undefined => {
    switch (value.kind) {
      case 'null':
        return undefined
      case 'number': {
        if (value.value.includes('.') || /e/i.test(value.value)) {
          return decimalLiteral(value.value)
        }
        const integer = BigInt(value.value)
        return integer >= -2147483648n && integer <= 2147483647n ?
          { name: 'int', args: [] } : decimalLiteral(value.value)
      }
      case 'string':
        return {
          name: value.national ? 'nvarchar' : 'varchar',
          args: [ Math.max(1, value.value.length) ]
        }
      case 'binary':
        return { name: 'varbinary', args: [ Math.max(1, Math.ceil((value.value.length - 2) / 2)) ] }
      case 'cast':
      case 'convert':
        return { ...value.type, name: canonical(value.type.name) }
      case 'column': {
        const type = Context.columnType(ctx, value.name)
        return type === undefined ? undefined : { ...type, name: canonical(type.name) }
      }
      case 'unary':
      case 'collate':
        return typeOf(ctx, value.kind === 'unary' ? value.operand : value.expression)
      case 'binaryOp':
        if (![ '+', '-', '*', '/', '%' ].includes(value.operator)) {
          return undefined
        }
        {
          const result = common(ctx, [ value.left, value.right ])
          const category = result === undefined ? undefined : Type.category(result)
          if (value.operator !== '+' ||
            ![ 'text', 'ntext', 'blob' ].includes(category ?? '')) {
            return result
          }
          const left = typeOf(ctx, value.left)
          const right = typeOf(ctx, value.right)
          const a = left?.args[0]
          const b = right?.args[0]
          const length = a === 'max' || b === 'max' ? 'max' :
            typeof a === 'number' && typeof b === 'number' ? a + b : result?.args[0]
          return result === undefined ? undefined : {
            ...result,
            args: length === undefined ? result.args : [ length ]
          }
        }
      case 'case':
        return common(ctx, [
          ...value.whens.map(when => when.then),
          ...value.else_ === undefined ? [] : [ value.else_ ]
        ])
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        if (name === 'count') {
          return { name: 'int', args: [] }
        }
        if (name === 'count_big') {
          return { name: 'bigint', args: [] }
        }
        if ([ 'sum', 'avg', 'min', 'max' ].includes(name ?? '')) {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          if (input === undefined || [ 'min', 'max' ].includes(name ?? '')) {
            return input
          }
          if ([ 'tinyint', 'smallint', 'int' ].includes(input.name)) {
            return { name: 'int', args: [] }
          }
          if ([ 'decimal', 'numeric' ].includes(input.name)) {
            const scale = typeof input.args[1] === 'number' ? input.args[1] : 0
            return { name: 'decimal', args: [ 38, name === 'avg' ? Math.max(6, scale) : scale ] }
          }
          if ([ 'real', 'float' ].includes(input.name)) {
            return { name: 'float', args: [] }
          }
          return input
        }
        if (name === 'isnull') {
          return value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0]) ??
            (value.args[1] === undefined ? undefined : typeOf(ctx, value.args[1]))
        }
        if ([ 'coalesce', 'iif', 'choose', 'min', 'max' ].includes(name ?? '')) {
          return common(ctx, value.args)
        }
        return undefined
      }
      default:
        return undefined
    }
  }

const maximumArgument =
  (types: readonly TypeName.t[], index: number): number | 'max' | undefined => {
    const values = types.map(type => type.args[index]).filter(value => value !== undefined)
    if (values.includes('max')) {
      return 'max'
    }
    const numbers = values.filter((value): value is number => typeof value === 'number')
    return numbers.length === 0 ? undefined : Math.max(...numbers)
  }

const decimalShape =
  (type: TypeName.t): readonly [ precision: number, scale: number ] | undefined => {
    switch (canonical(type.name)) {
      case 'decimal':
        return [ typeof type.args[0] === 'number' ? type.args[0] : 18,
          typeof type.args[1] === 'number' ? type.args[1] : 0 ]
      case 'tinyint':
        return [ 3, 0 ]
      case 'smallint':
        return [ 5, 0 ]
      case 'int':
        return [ 10, 0 ]
      case 'bigint':
        return [ 19, 0 ]
      case 'bit':
        return [ 1, 0 ]
      case 'smallmoney':
        return [ 10, 4 ]
      case 'money':
        return [ 19, 4 ]
      default:
        return undefined
    }
  }

const widenedDecimal =
  (types: readonly TypeName.t[]): TypeName.t => {
    const shapes = types.map(decimalShape).filter(shape => shape !== undefined)
    const scale = Math.max(0, ...shapes.map(shape => shape[1]))
    const integral = Math.max(0, ...shapes.map(shape => shape[0] - shape[1]))
    return { name: 'decimal', args: [ Math.min(38, integral + scale), scale ] }
  }

const widened =
  (winner: TypeName.t, types: readonly TypeName.t[]): TypeName.t => {
    const character = [ 'char', 'varchar', 'nchar', 'nvarchar' ]
    const binary = [ 'binary', 'varbinary' ]
    const winnerName = canonical(winner.name)
    if (winnerName === 'decimal') {
      return widenedDecimal(types)
    }
    const same = character.includes(winnerName) ?
      types.filter(type => character.includes(canonical(type.name))) :
      binary.includes(winnerName) ?
        types.filter(type => binary.includes(canonical(type.name))) :
        types.filter(type => canonical(type.name) === winnerName)
    const first = maximumArgument(same, 0)
    const second = maximumArgument(same, 1)
    return {
      name: winnerName,
      args: [
        ...first === undefined ? [] : [ first ],
        ...second === undefined ? [] : [ second ]
      ]
    }
  }

/** @returns the highest-precedence common type from already inferred types. */
export const commonTypes =
  (types: readonly TypeName.t[]): TypeName.t | undefined => {
    if (types.length === 0) {
      return undefined
    }
    const winner = types.reduce((left, right) =>
      (precedence[canonical(right.name)] ?? Number.MAX_SAFE_INTEGER) <
      (precedence[canonical(left.name)] ?? Number.MAX_SAFE_INTEGER) ? right : left)
    return widened(winner, types)
  }

/** @returns the highest-precedence common type for the supplied expressions. */
export const common =
  (ctx: Context.t, values: readonly Ast.Expression[]): TypeName.t | undefined => {
    if (values.some(value => value.kind !== 'null' && typeOf(ctx, value) === undefined)) {
      return undefined
    }
    return commonTypes(values.flatMap(value => typeOf(ctx, value) ?? []))
  }

/** @returns true when an expression already has the requested common type. */
export const same =
  (source: TypeName.t, target: TypeName.t): boolean =>
    canonical(source.name) === canonical(target.name) &&
    source.args.every((argument, index) => argument === target.args[index]) &&
    target.args.every((argument, index) => argument === source.args[index])

/** @returns true when an expression already has the requested common type. */
export const hasType =
  (ctx: Context.t, value: Ast.Expression, target: TypeName.t): boolean => {
    const source = typeOf(ctx, value)
    return source !== undefined && same(source, target)
  }

/** @returns canonical precedence rank for compatibility checks. */
export const rank =
  (type: TypeName.t): number =>
    precedence[canonical(type.name)] ?? Number.MAX_SAFE_INTEGER

/** @returns whether SQL Server defines an implicit conversion to the target. */
export const compatible =
  (source: TypeName.t, target: TypeName.t): boolean => {
    const sourceName = canonical(source.name)
    const targetName = canonical(target.name)
    if (sourceName === targetName) {
      return true
    }
    const sourceCategory = Type.category({ ...source, name: sourceName })
    const targetCategory = Type.category({ ...target, name: targetName })
    const numeric = [ 'integer', 'real', 'decimal', 'bit' ]
    const textual = [ 'text', 'ntext' ]
    const temporal = [ 'date', 'time', 'datetime' ]
    if (numeric.includes(targetCategory ?? '')) {
      return numeric.includes(sourceCategory ?? '') || textual.includes(sourceCategory ?? '') ||
        sourceCategory === 'blob'
    }
    if (temporal.includes(targetCategory ?? '')) {
      if (textual.includes(sourceCategory ?? '')) {
        return true
      }
      return targetCategory === 'time' ? sourceCategory === 'time' :
        sourceCategory !== 'time' && temporal.includes(sourceCategory ?? '')
    }
    if (targetCategory === 'guid') {
      return sourceCategory === 'guid' || textual.includes(sourceCategory ?? '') || sourceCategory === 'blob'
    }
    if (textual.includes(targetCategory ?? '')) {
      return textual.includes(sourceCategory ?? '') || sourceCategory === 'blob'
    }
    if (targetCategory === 'blob') {
      return sourceCategory === 'blob'
    }
    return false
  }

const call =
  (name: string, args: readonly Ast.Expression[]): Ast.Expression =>
    ({ kind: 'call', name: [ name ], args })

const string =
  (value: string): Ast.Expression =>
    ({ kind: 'string', value, national: false })

/** @returns an AST conversion that preserves implicit-conversion errors. */
export const coerce =
  (value: Ast.Expression, source: TypeName.t, target: TypeName.t): Ast.Expression => {
    if (same(source, target)) {
      return value
    }
    if (!compatible(source, target)) {
      const sourceCategory = Type.category(source)
      const targetCategory = Type.category(target)
      const temporal = [ 'date', 'time', 'datetime' ]
      const number = temporal.includes(sourceCategory ?? '') &&
        temporal.includes(targetCategory ?? '') &&
        (sourceCategory === 'time' || targetCategory === 'time') ? 402 : 206
      return call('mssqlite_implicit_error', [
        { kind: 'number', value: String(number) },
        string(number === 402 ?
          `The data types ${source.name} and ${target.name} are incompatible in the equal to operator.` :
          `Operand type clash: ${target.name} is incompatible with ${source.name}`)
      ])
    }
    const category = Type.category(target)
    if (category === 'integer' && Type.category(source) === 'blob') {
      return call('mssqlite_implicit_binary_integer', [ value, string(target.name) ])
    }
    if (category === 'bit') {
      return call('mssqlite_implicit_bit', [ value ])
    }
    if (category === 'real') {
      return call('mssqlite_implicit_real', [ value, string(target.name) ])
    }
    if ([ 'date', 'time', 'datetime' ].includes(category ?? '') && target.name !== 'datetimeoffset') {
      return call('mssqlite_implicit_temporal', [ value, string(target.name) ])
    }
    if (category === 'guid') {
      return call('mssqlite_implicit_guid', [ value ])
    }
    return { kind: 'cast', expression: value, type: target, try_: false }
  }

const derived =
  (value: Ast.Expression): boolean =>
    [ 'binaryOp', 'call', 'case', 'cast', 'convert' ].includes(value.kind)

const containsValues =
  (source: Ast.TableSource | undefined): boolean =>
    source?.kind === 'values' ||
    (source?.kind === 'join' && (containsValues(source.left) || containsValues(source.right)))

const nullable =
  (ctx: Context.t, value: Ast.Expression): boolean => {
    switch (value.kind) {
      case 'number':
      case 'string':
      case 'binary':
        return false
      case 'column':
        return Context.columnNullable(ctx, value.name) ?? true
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        return ![ 'count', 'count_big' ].includes(name ?? '')
      }
      default:
        return true
    }
  }

/** @returns metadata hints for projections whose common result type is known. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    const ctx = Context.of()
    return Context.withSourceTypes(ctx, select.from, () => {
      let hasDerived = containsValues(select.from)
      const hints = select.items.map(item => {
        if (item.kind !== 'expression') {
          return undefined
        }
        hasDerived ||= derived(item.expression)
        const type = typeOf(ctx, item.expression)
        if (type === undefined) {
          return undefined
        }
        return {
          name: item.alias ?? (item.expression.kind === 'column' ?
            item.expression.name[item.expression.name.length - 1] ?? '' : ''),
          type,
          nullable: nullable(ctx, item.expression)
        }
      })
      return !hasDerived || hints.some(hint => hint === undefined) ?
        undefined : hints as readonly ColumnHint[]
    })
  }
