import * as Context from './context.ts'
import * as Collation from './collation.ts'
import * as Decimal from './decimal.ts'
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

const literalCount =
  (value: Ast.Expression | undefined): number | undefined =>
    value?.kind === 'number' && /^\d+$/.test(value.value) ? Number(value.value) : undefined

const textWidth =
  (type: TypeName.t, width: number | 'max'): TypeName.t =>
    ({ ...type, args: [ width ] })

const textLimit =
  (type: TypeName.t): number =>
    Type.category(type) === 'ntext' ? 4000 : 8000

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
          const exact = Decimal.typeOf(ctx, value)
          if (exact !== undefined) {
            return { name: 'decimal', args: [ exact.precision, exact.scale ] }
          }
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
        if ([ 'getdate', 'getutcdate', 'current_timestamp', 'datetimefromparts' ].includes(name ?? '')) {
          return { name: 'datetime', args: [] }
        }
        if ([ 'sysdatetime', 'sysutcdatetime' ].includes(name ?? '')) {
          return { name: 'datetime2', args: [ 7 ] }
        }
        if ([ 'datefromparts', 'eomonth' ].includes(name ?? '')) {
          return { name: 'date', args: [] }
        }
        if (name === 'dateadd') {
          return value.args[2] === undefined ? undefined : typeOf(ctx, value.args[2])
        }
        if ([
          'datediff', 'datepart', 'year', 'month', 'day', 'isdate',
          'len', 'charindex', 'patindex', 'ascii', 'unicode', 'isnumeric',
          'db_id', 'object_id', 'schema_id', 'type_id',
          'error_number', 'error_severity', 'error_state', 'error_line', 'xact_state', 'isjson'
        ].includes(name ?? '')) {
          return { name: 'int', args: [] }
        }
        if (name === 'datalength') {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          return { name: input?.args[0] === 'max' ? 'bigint' : 'int', args: [] }
        }
        if (name === 'datename') {
          return { name: 'nvarchar', args: [ 30 ] }
        }
        if (name === 'char') {
          return { name: 'varchar', args: [ 1 ] }
        }
        if (name === 'nchar') {
          return { name: 'nchar', args: [ 1 ] }
        }
        if (name === 'space') {
          return { name: 'varchar', args: [ Math.min(8000, literalCount(value.args[0]) ?? 8000) ] }
        }
        if (name === 'quotename') {
          return { name: 'nvarchar', args: [ 258 ] }
        }
        if ([ 'ltrim', 'rtrim', 'trim', 'upper', 'lower', 'reverse' ].includes(name ?? '')) {
          return value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
        }
        if ([ 'substring', 'left', 'right' ].includes(name ?? '')) {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          if (input === undefined || input.args[0] === 'max') {
            return input
          }
          const requested = literalCount(value.args[name === 'substring' ? 2 : 1])
          return textWidth(input, requested === undefined ? input.args[0] as number :
            Math.min(input.args[0] as number, requested))
        }
        if (name === 'replicate') {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          if (input === undefined || input.args[0] === 'max') {
            return input
          }
          const count = literalCount(value.args[1])
          return textWidth(input, Math.min(textLimit(input),
            count === undefined ? textLimit(input) : (input.args[0] as number) * count))
        }
        if ([ 'replace', 'translate', 'string_agg' ].includes(name ?? '')) {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          return input === undefined || input.args[0] === 'max' ? input : textWidth(input, textLimit(input))
        }
        if (name === 'stuff') {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          const replacement = value.args[3] === undefined ? undefined : typeOf(ctx, value.args[3])
          if (input === undefined || input.args[0] === 'max' || replacement?.args[0] === 'max') {
            return input
          }
          const removed = literalCount(value.args[2]) ?? 0
          const added = typeof replacement?.args[0] === 'number' ? replacement.args[0] : 0
          return textWidth(input, Math.min(textLimit(input),
            Math.max(0, (input.args[0] as number) - removed + added)))
        }
        if ([ 'concat', 'concat_ws' ].includes(name ?? '')) {
          const offset = name === 'concat_ws' ? 1 : 0
          const inputs = value.args.slice(offset).flatMap(argument => typeOf(ctx, argument) ?? [])
          const result = commonTypes(inputs)
          if (result === undefined) {
            return undefined
          }
          const lengths = inputs.map(type => type.args[0])
          const maximum = Type.category(result) === 'ntext' ? 4000 : 8000
          const width = lengths.includes('max') ? 'max' : Math.min(maximum,
            lengths.reduce<number>((sum, length) => sum + (typeof length === 'number' ? length : 0), 0))
          return { ...result, args: [ width ] }
        }
        if (name === 'json_value' || name === 'json_query') {
          return { name: 'nvarchar', args: [ 4000 ] }
        }
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
        if ([ 'row_number', 'rank', 'dense_rank', 'ntile' ].includes(name ?? '')) {
          return { name: 'bigint', args: [] }
        }
        if ([ 'lag', 'lead', 'first_value', 'last_value' ].includes(name ?? '')) {
          return value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
        }
        if ([ 'abs', 'round', 'ceiling', 'floor', 'sign' ].includes(name ?? '')) {
          const input = value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
          return input === undefined || ![ 'ceiling', 'floor' ].includes(name ?? '') ||
            ![ 'decimal', 'numeric' ].includes(input.name) ? input : {
              ...input,
              args: [ input.args[0] ?? 18, 0 ]
            }
        }
        if ([
          'power', 'sqrt', 'square', 'exp', 'log', 'log10', 'pi', 'rand', 'degrees',
          'radians', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atn2'
        ].includes(name ?? '')) {
          return { name: 'float', args: [] }
        }
        if (name === 'newid') {
          return { name: 'uniqueidentifier', args: [] }
        }
        if ([ 'scope_identity', 'ident_current' ].includes(name ?? '')) {
          return { name: 'decimal', args: [ 38, 0 ] }
        }
        if (name === 'serverproperty') {
          return { name: 'sql_variant', args: [] }
        }
        if (name === 'object_definition') {
          return { name: 'nvarchar', args: [ 'max' ] }
        }
        if (name === 'error_message') {
          return { name: 'nvarchar', args: [ 4000 ] }
        }
        if ([
          'db_name', 'object_name', 'schema_name', 'type_name', 'suser_sname',
          'system_user', 'session_user', 'current_user', 'user', 'user_name',
          'host_name', 'app_name', 'error_procedure'
        ].includes(name ?? '')) {
          return { name: 'nvarchar', args: [ 128 ] }
        }
        if (name === 'isnull') {
          return value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0]) ??
            (value.args[1] === undefined ? undefined : typeOf(ctx, value.args[1]))
        }
        if (name === 'nullif') {
          return value.args[0] === undefined ? undefined : typeOf(ctx, value.args[0])
        }
        if (name === 'coalesce') {
          return common(ctx, value.args)
        }
        if (name === 'iif') {
          return common(ctx, value.args.slice(1))
        }
        if (name === 'choose') {
          return common(ctx, value.args.slice(1))
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

const callNullable =
  (ctx: Context.t, value: Ast.Expression & { readonly kind: 'call' }): boolean => {
    const name = value.name[value.name.length - 1]?.toLowerCase()
    if ([
      'getdate', 'getutcdate', 'current_timestamp', 'sysdatetime', 'sysutcdatetime',
      'concat', 'concat_ws'
    ].includes(name ?? '')) {
      return false
    }
    if ([ 'isnull', 'coalesce' ].includes(name ?? '')) {
      return value.args.every(argument => selectIntoNullable(ctx, argument))
    }
    return name === 'iif' ?
      value.args.slice(1).some(argument => selectIntoNullable(ctx, argument)) : true
  }

const selectIntoNullable =
  (ctx: Context.t, value: Ast.Expression): boolean => {
    switch (value.kind) {
      case 'null':
        return true
      case 'number':
      case 'string':
      case 'binary':
        return false
      case 'column':
        return Context.columnNullable(ctx, value.name) ?? true
      case 'collate':
        return selectIntoNullable(ctx, value.expression)
      case 'cast':
      case 'convert':
      case 'unary':
        return true
      case 'binaryOp': {
        const type = typeOf(ctx, value)
        return value.operator === '+' &&
          [ 'text', 'ntext' ].includes(Type.category(type ?? { name: '', args: [] }) ?? '') ?
          selectIntoNullable(ctx, value.left) || selectIntoNullable(ctx, value.right) : true
      }
      case 'case':
        return value.else_ === undefined ||
          value.whens.some(when => selectIntoNullable(ctx, when.then)) ||
          selectIntoNullable(ctx, value.else_)
      case 'call':
        return callNullable(ctx, value)
      default:
        return true
    }
  }

type IntoProjection = {
  readonly name: string,
  readonly type: TypeName.t,
  readonly nullable: boolean,
  readonly collation?: string
}

const intoTerm =
  (select: Ast.Select): readonly IntoProjection[] | undefined => {
    const ctx = Context.of()
    return Context.withSourceTypes(ctx, select.from, () => {
      const columns = select.items.map(item => {
        if (item.kind !== 'expression') {
          return undefined
        }
        const type = item.expression.kind === 'null' ? { name: 'int', args: [] } :
          typeOf(ctx, item.expression)
        if (type === undefined) {
          return undefined
        }
        const collation = Collation.ofExpression(ctx, item.expression)
        return {
          name: item.alias ?? (item.expression.kind === 'column' ?
            item.expression.name[item.expression.name.length - 1] ?? '' : ''),
          type,
          nullable: selectIntoNullable(ctx, item.expression),
          ...collation === undefined ? {} : { collation }
        }
      })
      return columns.some(column => column === undefined) ?
        undefined : columns as readonly IntoProjection[]
    })
  }

/** @returns typed target columns for SELECT INTO, including set-operation widening. */
export const selectIntoHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    const terms: Ast.Select[] = []
    for (let term: Ast.Select | undefined = select; term !== undefined; term = term.union?.select) {
      terms.push(term)
    }
    const projected = terms.map(intoTerm)
    const first = projected[0]
    if (first === undefined || projected.some(columns => columns === undefined || columns.length !== first.length)) {
      return undefined
    }
    return first.map((column, index): ColumnHint => ({
      name: column.name,
      type: commonTypes(projected.flatMap(columns => columns?.[index]?.type ?? [])) ?? column.type,
      nullable: projected.some(columns => columns?.[index]?.nullable !== false),
      ...projected.flatMap(columns => columns?.[index]?.collation ?? [])[0] === undefined ? {} : {
        collation: projected.flatMap(columns => columns?.[index]?.collation ?? [])[0]
      }
    }))
  }

/** @returns exact metadata for any fully inferred scalar projection. */
export const projectionHints =
  selectIntoHints

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
