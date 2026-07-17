import * as Context from './context.ts'
import * as Collation from './collation.ts'
import * as Implicit from './implicit.ts'
import * as Quote from './quote.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

type Family =
  | 'char'
  | 'varchar'
  | 'nchar'
  | 'nvarchar'

const names: Readonly<Record<string, Family>> = {
  char: 'char',
  character: 'char',
  varchar: 'varchar',
  'character varying': 'varchar',
  nchar: 'nchar',
  'national char': 'nchar',
  'national character': 'nchar',
  nvarchar: 'nvarchar',
  'national char varying': 'nvarchar',
  'national character varying': 'nvarchar'
}

const rank: Readonly<Record<Family, number>> = {
  char: 0,
  varchar: 1,
  nchar: 2,
  nvarchar: 3
}

/** @returns canonical character family, `undefined` for another SQL type. */
export const family =
  (type: TypeName.t): Family | undefined =>
    names[type.name]

/** @returns a canonical character type with its contextual default width. */
export const normalize =
  (type: TypeName.t, defaultWidth: number): TypeName.t | undefined => {
    const family_ = family(type)
    if (family_ === undefined) {
      return undefined
    }
    return {
      name: family_,
      args: [ type.args[0] ?? defaultWidth ]
    }
  }

/** @returns numeric UDF width where `-1` represents MAX. */
export const width =
  (type: TypeName.t, defaultWidth: number): number =>
    type.args[0] === 'max' ? -1 :
      typeof type.args[0] === 'number' ? type.args[0] : defaultWidth

const preferred =
  (types: readonly TypeName.t[]): TypeName.t | undefined => {
    const characters = types.flatMap(type => normalize(type, 1) ?? [])
    if (characters.length === 0) {
      return undefined
    }
    const family_ = characters
      .map(type => family(type) ?? 'varchar')
      .reduce((left, right) => rank[right] > rank[left] ? right : left)
    const lengths = characters.map(type => type.args[0] ?? 1)
    const length = lengths.includes('max') ? 'max' : Math.max(...lengths as number[])
    return { name: family_, args: [ length ] }
  }

/** @returns statically known character type of an expression. */
export const typeOf =
  (ctx: Context.t, value: Ast.Expression | undefined): TypeName.t | undefined => {
    if (value === undefined) {
      return undefined
    }
    switch (value.kind) {
      case 'string':
        return {
          name: value.national ? 'nvarchar' : 'varchar',
          args: [ Math.max(1, value.value.length) ]
        }
      case 'column': {
        const type = Context.columnType(ctx, value.name)
        return type === undefined ? undefined : normalize(type, 1)
      }
      case 'variable':
        return undefined
      case 'cast':
      case 'convert':
        return normalize(value.type, 30)
      case 'collate':
        return typeOf(ctx, value.expression)
      case 'binaryOp':
        if (value.operator !== '+') {
          return undefined
        }
        {
          const result = Implicit.typeOf(ctx, value)
          return result === undefined ? undefined : normalize(result, 1)
        }
      case 'case': {
        const types = [
          ...value.whens.map(when => typeOf(ctx, when.then)),
          ...value.else_ === undefined ? [] : [ typeOf(ctx, value.else_) ]
        ].filter((type): type is TypeName.t => type !== undefined)
        return preferred(types)
      }
      case 'call': {
        const name = value.name[value.name.length - 1]?.toLowerCase()
        if (name === 'char') {
          return { name: 'varchar', args: [ 1 ] }
        }
        if (name === 'nchar') {
          return { name: 'nchar', args: [ 1 ] }
        }
        if (name === 'isnull') {
          return typeOf(ctx, value.args[0]) ?? typeOf(ctx, value.args[1])
        }
        if ([ 'coalesce', 'iif', 'choose', 'min', 'max' ].includes(name ?? '')) {
          return preferred(value.args.flatMap(argument => typeOf(ctx, argument) ?? []))
        }
        if ([
          'upper', 'lower', 'ltrim', 'rtrim', 'trim', 'substring', 'left', 'right',
          'replace', 'replicate', 'reverse', 'stuff'
        ].includes(name ?? '')) {
          return typeOf(ctx, value.args[0])
        }
        return undefined
      }
      default:
        return undefined
    }
  }

/** @returns explicit character conversion SQL. */
export const cast =
  (value: string, type: TypeName.t, try_: boolean, defaultWidth = 30): string => {
    const normalized = normalize(type, defaultWidth)
    if (normalized === undefined) {
      return value
    }
    return `mssqlite_cast_character(${value}, ${Quote.string(normalized.name)}, ` +
      `${width(normalized, defaultWidth)}, ${try_ ? 1 : 0})`
  }

/** @returns storage conversion SQL that rejects overlong character input. */
export const store =
  (value: string, type: TypeName.t, column: string): string => {
    const normalized = normalize(type, 1)
    if (normalized === undefined) {
      return value
    }
    return `mssqlite_store_character(${value}, ${Quote.string(normalized.name)}, ` +
      `${width(normalized, 1)}, ${Quote.string(column)})`
  }

const nameOf =
  (item: Ast.SelectItem): string =>
    item.kind !== 'expression' ? '' :
      item.alias ?? (item.expression.kind === 'column' ?
        item.expression.name[item.expression.name.length - 1] ?? '' : '')

const hintType =
  (ctx: Context.t, value: Ast.Expression): TypeName.t | undefined => {
    const character = typeOf(ctx, value)
    if (character !== undefined) {
      return character
    }
    switch (value.kind) {
      case 'number': {
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
            'int' : 'bigint',
          args: []
        }
      }
      case 'cast':
      case 'convert':
        return value.type
      case 'column':
        return Context.columnType(ctx, value.name)
      case 'call':
        return [ 'ascii', 'unicode', 'len', 'datalength' ].includes(
          value.name[value.name.length - 1]?.toLowerCase() ?? '') ?
          { name: 'int', args: [] } : undefined
      default:
        return undefined
    }
  }

const nullable =
  (ctx: Context.t, value: Ast.Expression): boolean => {
    switch (value.kind) {
      case 'null':
        return true
      case 'string':
      case 'number':
        return false
      case 'column':
        return Context.columnNullable(ctx, value.name) ?? true
      case 'cast':
      case 'convert':
        return true
      case 'collate':
        return nullable(ctx, value.expression)
      case 'call':
        return value.name[value.name.length - 1]?.toLowerCase() !== 'isnull'
      default:
        return true
    }
  }

/** @returns stable character metadata when every projected item is character typed. */
export const selectHints =
  (select: Ast.Select): readonly ColumnHint[] | undefined => {
    const ctx = Context.of()
    return Context.withSourceTypes(ctx, select.from, () => {
      let hasCharacter = false
      const hints = select.items.map(item => {
        if (item.kind !== 'expression') {
          return undefined
        }
        hasCharacter ||= typeOf(ctx, item.expression) !== undefined
        const type = hintType(ctx, item.expression)
        const collation = Collation.ofExpression(ctx, item.expression)
        return type === undefined ? undefined : {
          name: nameOf(item),
          type,
          nullable: nullable(ctx, item.expression),
          ...collation === undefined ? {} : { collation }
        }
      })
      return !hasCharacter || hints.some(hint => hint === undefined) ?
        undefined : hints as readonly ColumnHint[]
    })
  }
