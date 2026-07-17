import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Buffer } from 'node:buffer'
import { dateadd, datediff, datename, datepart, eomonth } from './date-functions.ts'
import * as Character from './character.ts'
import * as Implicit from './implicit.ts'
import * as Identity from './identity.ts'
import * as DecimalExact from './decimal.ts'
import * as DateTimeOffset from './datetimeoffset.ts'
import { nextSequenceValue } from './sequence.ts'
import { nextRowversionValue } from './rowversion.ts'
import { MssqlError } from './error.ts'
import { SqlVariant, TypeInfo } from '@mssqlite/tds'
import { Type as TranspileType } from '@mssqlite/transpile'
import type { Server } from './session.ts'
import type { DatabaseSync } from 'node:sqlite'

type Argument =
  null | number | bigint | string | Uint8Array

const text =
  (value: Argument): string =>
    typeof value === 'string' ? value : String(value ?? '')

const integerArgument =
  (value: Argument): number =>
    Math.trunc(Number(value))

const utf16Text =
  (value: Argument): string =>
    value instanceof Uint8Array ?
      Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf16le') : text(value)

const hasUnpairedSurrogate =
  (value: string): boolean => {
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index)
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          index++
        } else {
          return true
        }
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true
      }
    }
    return false
  }

const utf16Result =
  (value: string): string | Uint8Array =>
    hasUnpairedSurrogate(value) ? Uint8Array.from(Buffer.from(value, 'utf16le')) : value

const invalidStringLength =
  (name: string): MssqlError =>
    new MssqlError(
      `Invalid length parameter passed to the ${name.toUpperCase()} function.`,
      536, 16, 1, { statementTerminating: true })

const substring =
  (value: Argument, start: Argument, length: Argument): Argument => {
    if (value === null || start === null || length === null) {
      return null
    }
    const count = integerArgument(length)
    if (count < 0) {
      throw invalidStringLength('substring')
    }
    const at = integerArgument(start)
    const available = at < 1 ? Math.max(0, at + count - 1) : count
    const offset = Math.max(0, at - 1)
    return utf16Result(utf16Text(value).slice(offset, offset + available))
  }

const leftString =
  (value: Argument, length: Argument): Argument => {
    if (value === null || length === null) {
      return null
    }
    const count = integerArgument(length)
    if (count < 0) {
      throw invalidStringLength('left')
    }
    return utf16Result(utf16Text(value).slice(0, count))
  }

const rightString =
  (value: Argument, length: Argument): Argument => {
    if (value === null || length === null) {
      return null
    }
    const count = integerArgument(length)
    if (count < 0) {
      throw invalidStringLength('right')
    }
    return count === 0 ? '' : utf16Result(utf16Text(value).slice(-count))
  }

const quotePairs: Readonly<Record<string, readonly [ string, string ]>> = {
  '\'': [ '\'', '\'' ],
  '[': [ '[', ']' ],
  ']': [ '[', ']' ],
  '"': [ '"', '"' ],
  '(': [ '(', ')' ],
  ')': [ '(', ')' ],
  '<': [ '<', '>' ],
  '>': [ '<', '>' ],
  '{': [ '{', '}' ],
  '}': [ '{', '}' ],
  '`': [ '`', '`' ]
}

const quotename =
  (value: Argument, quote?: Argument): Argument => {
    if (value === null || quote === null) {
      return null
    }
    const source = text(value)
    const delimiter = quote === undefined ? '[' : text(quote)
    const pair = quotePairs[delimiter]
    if (source.length > 128 || delimiter.length !== 1 || pair === undefined) {
      return null
    }
    const [ open, close ] = pair
    return open + source.replaceAll(close, close + close) + close
  }

const decimalArgument =
  (value: Argument): string | number | bigint | null =>
    value instanceof Uint8Array ? text(value) : value

const variantDecimalType =
  (value: Argument, precision: number, scale: number): TypeInfo.t => {
    if (precision >= 1 && scale >= 0) {
      return TypeInfo.decimalN(precision, scale)
    }
    const source = text(value).replace(/^[+-]/, '')
    const [ whole = '', fraction = '' ] = source.toLowerCase().split('e')[0]?.split('.') ?? []
    const resolvedScale = fraction.length
    return TypeInfo.decimalN(Math.min(38, Math.max(1, whole.replace(/^0+/, '').length + resolvedScale)), resolvedScale)
  }

const variantBase =
  (value: Exclude<Argument, null>, name: string, first: number, second: number): TypeInfo.t => {
    switch (name) {
      case 'tinyint':
        return TypeInfo.intN(1)
      case 'smallint':
        return TypeInfo.intN(2)
      case 'int':
      case 'integer':
        return TypeInfo.intN(4)
      case 'bigint':
        return TypeInfo.intN(8)
      case 'bit':
        return TypeInfo.bitN()
      case 'real':
        return TypeInfo.floatN(4)
      case 'float':
        return TypeInfo.floatN(8)
      case 'decimal':
      case 'numeric':
      case 'dec':
        return variantDecimalType(value, first, second)
      case 'varchar':
      case 'char':
        return TypeInfo.varchar(first >= 0 ? first : text(value).length)
      case 'varbinary':
      case 'binary':
        return TypeInfo.varbinary(first >= 0 ? first : (value as Uint8Array).byteLength)
      case 'nvarchar':
      case 'nchar':
      case 'string':
        return TypeInfo.nvarchar(first >= 0 ? first : text(value).length)
      case 'uniqueidentifier':
        return TypeInfo.guid()
      default:
        return value instanceof Uint8Array ? TypeInfo.varbinary(value.byteLength) :
          typeof value === 'bigint' ? TypeInfo.intN(8) :
            typeof value === 'number' ?
              (Number.isInteger(value) ? TypeInfo.intN(4) : TypeInfo.floatN(8)) :
              TypeInfo.nvarchar(text(value).length)
    }
  }

const normalizedCollationText =
  (value: string, collation: Argument, trim: boolean): string => {
    const name = text(collation).toLowerCase()
    const accentSensitive = !name.endsWith('_ai')
    const caseSensitive = name.includes('_cs_') || name.endsWith('_bin2')
    let key = trim ? value.trimEnd() : value
    if (!accentSensitive) {
      key = key.normalize('NFD').replace(/\p{M}/gu, '')
    }
    return caseSensitive ? key : key.toLocaleLowerCase('en-US')
  }

const collationKey =
  (value: Argument, collation: Argument): Argument =>
    value === null ? null : normalizedCollationText(text(value), collation, true)

/** @returns last part of a dotted, optionally bracketed object name. */
const namePart =
  (value: string): string => {
    const parts = value.split('.')
    const last = parts[parts.length - 1] ?? ''
    return last.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '')
  }

const regexpLiteral =
  (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const regexpClassLiteral =
  (value: string): string =>
    value.replaceAll('\\', '\\\\').replaceAll('[', '\\[')
      .replaceAll(']', '\\]').replaceAll('-', '\\-').replaceAll('^', '\\^')

const likeClassSource =
  (pattern: string, start: number, escape: string): readonly [ source: string, end: number ] | undefined => {
    let source = ''
    for (let i = start + 1; i < pattern.length; i++) {
      const char = pattern[i] ?? ''
      if (escape !== '' && char === escape && i + 1 < pattern.length) {
        source += regexpClassLiteral(pattern[++i] ?? '')
      } else if (char === ']') {
        return [ `[${source}]`, i ]
      } else if (char === '[' || char === '\\') {
        source += `\\${char}`
      } else {
        source += char
      }
    }
    return undefined
  }

/** @returns SQL LIKE pattern body converted to regular expression source. */
const likePatternSource =
  (pattern: string, escape = ''): string => {
    let out = ''
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i] ?? ''
      if (escape !== '' && char === escape && i + 1 < pattern.length) {
        out += regexpLiteral(pattern[++i] ?? '')
      } else if (char === '%') {
        out += '[\\s\\S]*'
      } else if (char === '_') {
        out += '[\\s\\S]'
      } else if (char === '[') {
        const class_ = likeClassSource(pattern, i, escape)
        if (class_ === undefined) {
          out += '\\['
        } else {
          out += class_[0]
          i = class_[1]
        }
      } else {
        out += regexpLiteral(char)
      }
    }
    return out
  }

/** @returns 1-based position of the first LIKE pattern match, 0 when absent. */
const patindex =
  (pattern: string, source: string): number => {
    const leading = pattern.startsWith('%')
    const trailing = pattern.endsWith('%') && !pattern.endsWith('\\%')
    const core = pattern.slice(leading ? 1 : 0, trailing ? -1 : undefined)
    const regexp = new RegExp(`^${likePatternSource(core)}${trailing ? '' : '$'}`, 'i')
    if (!leading) {
      return regexp.test(source) ? 1 : 0
    }
    for (let i = 0; i < source.length; i++) {
      if (regexp.test(source.slice(i))) {
        return i + 1
      }
    }
    return 0
  }

const serverProperties =
  (server: Server): Record<string, string | number> => ({
    productversion: '15.0.2000.5',
    productlevel: 'RTM',
    productmajorversion: '15',
    edition: 'Express Edition (64-bit)',
    editionid: -1592396055,
    engineedition: 4,
    machinename: hostname(),
    servername: server.serverName,
    instancename: '',
    collation: 'SQL_Latin1_General_CP1_CI_AS',
    isintegratedsecurityonly: 0,
    isclustered: 0,
    ishadrenabled: 0,
    isxtpsupported: 0
  })

const castInteger =
  (
    server: Server,
    value: Argument,
    type: Argument,
    try_: Argument,
    numeric: Argument,
    variable: Argument
  ): Argument => {
    try {
      const declared = server.current?.variables.get(text(variable).toLowerCase())?.type
      const numericVariable = declared !== undefined && [ 'integer', 'real', 'decimal', 'bit' ].includes(
        TranspileType.category(declared) ?? '')
      return Implicit.integer(
        value, text(type).toLowerCase(), Number(numeric) !== 0 || numericVariable) as Argument
    } catch (error) {
      if (Number(try_) !== 0) {
        return null
      }
      throw error
    }
  }

const arithmeticReturnsNull =
  (server: Server): boolean =>
    server.current?.options.get('arithabort') === 'off' &&
    server.current.options.get('ansi_warnings') === 'off'

const arithmeticError =
  (server: Server, error: MssqlError): null => {
    if (arithmeticReturnsNull(server)) {
      return null
    }
    throw error
  }

const checkedArithmetic =
  (server: Server, operator: Argument, left: Argument, right: Argument, width: Argument): Argument => {
    if (left === null || right === null) {
      return null
    }
    const op = text(operator)
    if ((op === '/' || op === '%') && Number(right) === 0) {
      return arithmeticError(server,
        new MssqlError('Divide by zero error encountered.', 8134, 16, 1, { statementTerminating: true }))
    }
    if ((typeof left === 'bigint' || Number.isInteger(left)) &&
      (typeof right === 'bigint' || Number.isInteger(right))) {
      const a = BigInt(left as number | bigint)
      const b = BigInt(right as number | bigint)
      const result = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b :
        op === '/' ? a / b : a % b
      const bits = Number(width)
      const minimum = bits === 32 ? -2147483648n : bits === 64 ? -9223372036854775808n : undefined
      const maximum = bits === 32 ? 2147483647n : bits === 64 ? 9223372036854775807n : undefined
      if (minimum !== undefined && maximum !== undefined && (result < minimum || result > maximum)) {
        return arithmeticError(server, new MssqlError(
          'Arithmetic overflow error converting expression to data type int.',
          8115, 16, 1, { statementTerminating: true }))
      }
      return result >= Number.MIN_SAFE_INTEGER && result <= Number.MAX_SAFE_INTEGER ? Number(result) : result
    }
    const a = Number(left)
    const b = Number(right)
    return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b :
      op === '/' ? a / b : a % b
  }

const sumStep =
  (state: string, value: Argument, bits: 32 | 64): string => {
    if (state === 'overflow' || value === null) {
      return state
    }
    if (!Number.isInteger(value) && typeof value !== 'bigint') {
      const current = state === 'empty' ? 0 : Number(state.slice(2))
      return `f:${current + Number(value)}`
    }
    if (state.startsWith('f:')) {
      return `f:${Number(state.slice(2)) + Number(value)}`
    }
    const current = state === 'empty' ? 0n : BigInt(state.slice(2))
    const sum = current + BigInt(value as number | bigint)
    const minimum = bits === 32 ? -2147483648n : -9223372036854775808n
    const maximum = bits === 32 ? 2147483647n : 9223372036854775807n
    if (sum < minimum || sum > maximum) {
      return 'overflow'
    }
    return `i:${sum}`
  }

const sumResult =
  (server: Server, state: string): Argument => {
    if (state === 'empty') {
      return null
    }
    if (state === 'overflow') {
      return arithmeticError(server, new MssqlError(
        'Arithmetic overflow error converting expression to data type int.',
        8115, 16, 1, { statementTerminating: true }))
    }
    return state.startsWith('f:') ? Number(state.slice(2)) : Number(BigInt(state.slice(2)))
  }

const averageState =
  (state: string): readonly [ sum: bigint, count: bigint ] => {
    if (state === 'empty') {
      return [ 0n, 0n ]
    }
    const [ sum = '0', count = '0' ] = state.slice(2).split(':')
    return [ BigInt(sum), BigInt(count) ]
  }

const averageStep =
  (state: string, value: Argument, direction: 1 | -1): string => {
    if (value === null) {
      return state
    }
    const [ sum, count ] = averageState(state)
    const nextCount = count + BigInt(direction)
    const delta = BigInt(value as number | bigint) * BigInt(direction)
    return nextCount === 0n ? 'empty' : `i:${sum + delta}:${nextCount}`
  }

const averageResult =
  (server: Server, state: string, bits: 32 | 64): Argument => {
    if (state === 'empty') {
      return null
    }
    const [ sum, count ] = averageState(state)
    const minimum = bits === 32 ? -2147483648n : -9223372036854775808n
    const maximum = bits === 32 ? 2147483647n : 9223372036854775807n
    if (sum < minimum || sum > maximum) {
      const target = bits === 32 ? 'int' : 'bigint'
      return arithmeticError(server, new MssqlError(
        `Arithmetic overflow error converting expression to data type ${target}.`,
        8115, 16, 2, { statementTerminating: true }))
    }
    const result = sum / count
    return result >= Number.MIN_SAFE_INTEGER && result <= Number.MAX_SAFE_INTEGER ? Number(result) : result
  }

/**
 * Registers all `mssqlite_*` SQL functions the transpiler emits. Session
 * scoped functions read `server.current`, set by the engine per batch.
 */
export const registerFunctions =
  (server: Server, db: DatabaseSync = server.db): void => {
    const define =
      (name: string, fn: (...args: Argument[]) => Argument, options: { deterministic?: boolean, varargs?: boolean } = {}): void => {
        db.function(name, { deterministic: options.deterministic ?? true, varargs: options.varargs ?? false }, fn)
      }
    define('mssqlite_add', (a, b) => {
      if (a === null || b === null) {
        return null
      }
      if (typeof a === 'string' || typeof b === 'string') {
        if (typeof a === 'string' && typeof b === 'string') {
          return a + b
        }
        // Mixed string and number — MSSQL converts the string to a number.
        return Number(a) + Number(b)
      }
      if (typeof a === 'bigint' || typeof b === 'bigint') {
        return BigInt(a as number | bigint) + BigInt(b as number | bigint)
      }
      return (a as number) + (b as number)
    })
    define('mssqlite_collation_key', collationKey)
    define('mssqlite_datetimeoffset_cast', (value, scale, try_) =>
      DateTimeOffset.cast(value === null ? null : text(value), Number(scale), Number(try_) !== 0))
    define('mssqlite_datetimeoffset_key', value =>
      DateTimeOffset.key(value === null ? null : text(value)))
    define('mssqlite_collation_like', (value, pattern, collation, escape) => {
      if (value === null || pattern === null || escape === null) {
        return null
      }
      const rawEscape = text(escape)
      if (rawEscape.length > 1) {
        throw new MssqlError(
          `The invalid escape character "${rawEscape}" was specified in a LIKE predicate.`,
          506, 16, 1, { statementTerminating: true })
      }
      const source = normalizedCollationText(text(value), collation, false)
      const pattern_ = normalizedCollationText(text(pattern), collation, false)
      const escape_ = normalizedCollationText(rawEscape, collation, false)
      try {
        const regexp = new RegExp(`^${likePatternSource(pattern_, escape_)}$`, 'u')
        return regexp.test(source) || regexp.test(source.trimEnd()) ? 1 : 0
      } catch (error) {
        if (error instanceof SyntaxError) {
          return 0
        }
        throw error
      }
    })
    define('mssqlite_arithmetic', (operator, left, right, width) =>
      checkedArithmetic(server, operator, left, right, width), { deterministic: false })
    define('mssqlite_generated_arithmetic', (operator, left, right, width) =>
      checkedArithmetic(server, operator, left, right, width))
    define('mssqlite_next_rowversion', () => nextRowversionValue(server), { deterministic: false })
    define('mssqlite_decimal_cast', (value, precision, scale, try_) =>
      DecimalExact.cast(decimalArgument(value), Number(precision), Number(scale), Number(try_) !== 0))
    define('mssqlite_variant_pack', (value, name, first, second) => {
      if (value === null) {
        return null
      }
      const declared = text(name).toLowerCase()
      const typeInfo = variantBase(value, declared, Number(first), Number(second))
      const coerced = declared === 'bigint' ? BigInt(value as number | bigint | string) :
        [ 'tinyint', 'smallint', 'int', 'integer', 'bit', 'real', 'float' ].includes(declared) ?
          Number(value) : value
      return SqlVariant.encode(typeInfo, coerced)
    })
    define('mssqlite_variant_unpack', value => {
      if (value === null) {
        return null
      }
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('sql_variant storage payload must be binary.')
      }
      return SqlVariant.decode(value).value as Argument
    })
    define('mssqlite_udt_cast', (value, type, try_) => {
      if (value === null || value instanceof Uint8Array) {
        return value
      }
      if (Number(try_) !== 0) {
        return null
      }
      throw new TypeError(`${text(type)} accepts only its native binary serialization.`)
    })
    define('mssqlite_xml_cast', (value, try_) => {
      if (value === null || typeof value === 'string') {
        return value
      }
      if (Number(try_) !== 0) {
        return null
      }
      throw new TypeError('xml accepts a Unicode character representation.')
    })
    define('mssqlite_decimal_arithmetic',
      (operator, left, right, leftScale, rightScale, precision, scale) => {
        try {
          return DecimalExact.arithmetic(
            text(operator), decimalArgument(left), decimalArgument(right), Number(leftScale), Number(rightScale),
            Number(precision), Number(scale))
        } catch (error) {
          if (error instanceof MssqlError && (error.number === 8115 || error.number === 8134)) {
            return arithmeticError(server, error)
          }
          throw error
        }
      }, { deterministic: false })
    define('mssqlite_decimal_generated_arithmetic',
      (operator, left, right, leftScale, rightScale, precision, scale) =>
        DecimalExact.arithmetic(
          text(operator), decimalArgument(left), decimalArgument(right),
          Number(leftScale), Number(rightScale), Number(precision), Number(scale)))
    define('mssqlite_decimal_compare', (left, right, leftScale, rightScale) =>
      DecimalExact.compare(
        decimalArgument(left), decimalArgument(right), Number(leftScale), Number(rightScale)))
    define('mssqlite_decimal_sort_key', (value, scale) =>
      DecimalExact.sortKey(decimalArgument(value), Number(scale)))
    db.aggregate('mssqlite_decimal_sum', {
      start: 'empty' as string,
      step: (state, value, inputScale, precision, scale) => DecimalExact.aggregateStep(
        String(state), decimalArgument(value as Argument), Number(inputScale), Number(precision), Number(scale)),
      result: state => DecimalExact.aggregateResult(String(state), false)
    })
    db.aggregate('mssqlite_decimal_avg', {
      start: 'empty' as string,
      step: (state, value, inputScale, precision, scale) => DecimalExact.aggregateStep(
        String(state), decimalArgument(value as Argument), Number(inputScale), Number(precision), Number(scale)),
      result: state => DecimalExact.aggregateResult(String(state), true)
    })
    db.aggregate('mssqlite_decimal_min', {
      start: 'empty' as string,
      step: (state, value, scale) => DecimalExact.extremumStep(
        String(state), decimalArgument(value as Argument), Number(scale), false),
      result: state => state === 'empty' ? null : String(state)
    })
    db.aggregate('mssqlite_decimal_max', {
      start: 'empty' as string,
      step: (state, value, scale) => DecimalExact.extremumStep(
        String(state), decimalArgument(value as Argument), Number(scale), true),
      result: state => state === 'empty' ? null : String(state)
    })
    db.aggregate('mssqlite_sum', {
      start: 'empty' as string,
      step: (state, value) => sumStep(String(state), value as Argument, 32),
      result: state => sumResult(server, String(state)),
      deterministic: false
    })
    db.aggregate('mssqlite_sum_bigint', {
      start: 'empty' as string,
      step: (state, value) => sumStep(String(state), value as Argument, 64),
      result: state => sumResult(server, String(state)),
      deterministic: false
    })
    db.aggregate('mssqlite_avg', {
      start: 'empty' as string,
      step: (state, value) => averageStep(String(state), value as Argument, 1),
      inverse: (state, value) => averageStep(String(state), value as Argument, -1),
      result: state => averageResult(server, String(state), 32),
      deterministic: false
    })
    db.aggregate('mssqlite_avg_bigint', {
      start: 'empty' as string,
      step: (state, value) => averageStep(String(state), value as Argument, 1),
      inverse: (state, value) => averageStep(String(state), value as Argument, -1),
      result: state => averageResult(server, String(state), 64),
      deterministic: false
    })
    define('mssqlite_cast_integer', (value, type, try_, numeric, variable) =>
      castInteger(server, value, type, try_, numeric, variable))
    define('mssqlite_temporal_cast', (value, target, try_) =>
      Implicit.tryTemporal(value, text(target), Number(try_) !== 0) as Argument)
    define('mssqlite_datefromparts', (year, month, day) =>
      Implicit.dateFromParts(year, month, day) as Argument)
    define('mssqlite_datetimefromparts', (year, month, day, hour, minute, second, millisecond) =>
      Implicit.datetimeFromParts(
        year, month, day, hour, minute, second, millisecond) as Argument)
    define('mssqlite_cast_character', (value, name, width, _try) =>
      Character.cast(value, {
        name: text(name), args: [ Number(width) < 0 ? 'max' : Number(width) ]
      }) as Argument)
    define('mssqlite_store_character', (value, name, width, column) =>
      Character.store(
        value,
        { name: text(name), args: [ Number(width) < 0 ? 'max' : Number(width) ] },
        text(column)) as Argument)
    define('mssqlite_ascii', value => Character.ascii(value))
    define('mssqlite_char', value => Character.char(value))
    define('mssqlite_implicit_bit', value => Implicit.bit(value) as Argument)
    define('mssqlite_implicit_real', (value, target) =>
      Implicit.real(value, text(target)) as Argument)
    define('mssqlite_implicit_temporal', (value, target) =>
      Implicit.temporal(value, text(target)) as Argument)
    define('mssqlite_implicit_guid', value => Implicit.guid(value) as Argument)
    define('mssqlite_implicit_binary_integer', (value, target) =>
      Implicit.binaryInteger(value, text(target)) as Argument)
    define('mssqlite_implicit_binary_concat', (left, right) =>
      Implicit.binaryConcat(left, right) as Argument)
    define('mssqlite_implicit_error', (number, message) => {
      throw new MssqlError(text(message), Number(number), 16, 1, { statementTerminating: true })
    }, { deterministic: false })
    define('mssqlite_next_identity', table => {
      const session = server.current
      if (session === undefined) {
        throw new MssqlError('Identity allocation requires an active session.', 8106, 16)
      }
      return Identity.nextValue(session, text(table).split('.')) as Argument
    }, { deterministic: false })
    define('mssqlite_explicit_identity', (table, value) => {
      const session = server.current
      if (session === undefined) {
        throw new MssqlError('Identity allocation requires an active session.', 8106, 16)
      }
      return Identity.explicitValue(session, text(table).split('.'), value) as Argument
    }, { deterministic: false })
    define('mssqlite_ident_current', table => {
      const session = server.current
      return session === undefined || table === null ? null : Identity.current(session, text(table)) as Argument
    }, { deterministic: false })
    define('mssqlite_string_split', (value, separator) => {
      if (value === null || separator === null || value === '') {
        return '[]'
      }
      const delimiter = text(separator)
      if ([ ...delimiter ].length !== 1 || delimiter === '\0') {
        throw new RangeError('STRING_SPLIT separator must be one character.')
      }
      return JSON.stringify(text(value).split(delimiter))
    })
    define('mssqlite_series_step', (start, stop, step) => {
      if (start === null || stop === null) {
        return null
      }
      const resolved = step ?? (Number(start) <= Number(stop) ? 1 : -1)
      if (Number(resolved) === 0) {
        throw new RangeError('GENERATE_SERIES step cannot be zero.')
      }
      return resolved
    })
    define('mssqlite_newid', () => randomUUID().toUpperCase(), { deterministic: false })
    define('mssqlite_rand', () => Math.random(), { deterministic: false })
    define('mssqlite_next_value_for', name => {
      const value = nextSequenceValue(server, text(name))
      return typeof value === 'boolean' ? Number(value) : value
    }, { deterministic: false })
    define('mssqlite_substring', substring)
    define('mssqlite_left', leftString)
    define('mssqlite_right', rightString)
    define('mssqlite_len', value =>
      value === null ? null : utf16Text(value).replace(/ +$/, '').length)
    define('mssqlite_unicode', value => {
      if (value === null) {
        return null
      }
      const source = utf16Text(value)
      return source.length === 0 ? null : source.charCodeAt(0)
    })
    define('mssqlite_nchar', value => {
      if (value === null) {
        return null
      }
      const unit = integerArgument(value)
      return unit < 0 || unit > 0xffff ? null : utf16Result(String.fromCharCode(unit))
    })
    define('mssqlite_replicate', (value, count) =>
      value === null || count === null ?
        null :
        integerArgument(count) < 0 ? null : text(value).repeat(integerArgument(count)))
    define('mssqlite_quotename', quotename, { varargs: true })
    define('mssqlite_reverse', value =>
      value === null ? null : utf16Result(utf16Text(value).split('').reverse().join('')))
    define('mssqlite_stuff', (value, start, length, replacement) => {
      if (value === null || start === null || length === null) {
        return null
      }
      const source = utf16Text(value)
      const at = Number(start)
      if (at < 1 || at > source.length) {
        return null
      }
      return utf16Result(
        source.slice(0, at - 1) + utf16Text(replacement ?? '') + source.slice((at - 1) + Number(length)))
    })
    define('mssqlite_charindex', (needle, hay, start) => {
      if (needle === null || hay === null) {
        return null
      }
      const from = Math.max(0, Number(start ?? 1) - 1)
      return text(hay).toLowerCase().indexOf(text(needle).toLowerCase(), from) + 1
    }, { varargs: true })
    define('mssqlite_patindex', (pattern, value) =>
      pattern === null || value === null ?
        null :
        patindex(text(pattern), text(value)))
    define('mssqlite_translate', (value, from, to) => {
      if (value === null || from === null || to === null) {
        return null
      }
      const source = [ ...text(value) ]
      const search = [ ...text(from) ]
      const replace = [ ...text(to) ]
      return source
        .map(char => {
          const at = search.findIndex(candidate => candidate.toLowerCase() === char.toLowerCase())
          return at === -1 ? char : replace[at] ?? char
        })
        .join('')
    })
    define('mssqlite_datalength', (value, type) =>
      Character.dataLength(value, type === undefined || type === null ? undefined : text(type)),
    { varargs: true })
    define('mssqlite_round', (value, digits, truncate) => {
      if (value === null || digits === null) {
        return null
      }
      const factor = 10 ** Number(digits)
      const scaled = Number(value) * factor
      return (truncate !== undefined && truncate !== null && Number(truncate) !== 0 ?
        Math.trunc(scaled) :
        Math.round(scaled)) / factor
    }, { varargs: true })
    define('mssqlite_isnumeric', value => {
      if (value === null) {
        return 0
      }
      if (typeof value === 'number' || typeof value === 'bigint') {
        return 1
      }
      return /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\s*$/i.test(text(value)) ? 1 : 0
    })
    define('mssqlite_isdate', value => {
      if (value === null) {
        return 0
      }
      try {
        datepart('year', text(value))
        return 1
      } catch {
        return 0
      }
    })
    define('mssqlite_name', value =>
      value === null ? null : namePart(text(value)))
    define('mssqlite_dateadd', (part, n, value) =>
      part === null || n === null || value === null ?
        null :
        dateadd(text(part), Number(n), text(value)))
    define('mssqlite_datediff', (part, from, to) =>
      part === null || from === null || to === null ?
        null :
        datediff(text(part), text(from), text(to)))
    define('mssqlite_datepart', (part, value) =>
      part === null || value === null ?
        null :
        datepart(text(part), text(value)))
    define('mssqlite_datename', (part, value) =>
      part === null || value === null ?
        null :
        datename(text(part), text(value)))
    define('mssqlite_eomonth', (value, n) =>
      value === null ?
        null :
        eomonth(text(value), Number(n ?? 0)))
    // Session-scoped.
    define('mssqlite_db_name', () =>
      server.current?.databaseState.name ?? server.databaseName, { deterministic: false })
    define('mssqlite_db_id', () => server.current?.databaseState.id ?? 5, { deterministic: false })
    define('mssqlite_scope_identity', () => {
      const identity = server.current?.scopeIdentity ?? null
      return typeof identity === 'boolean' ? (identity ? 1 : 0) : identity
    }, { deterministic: false })
    define('mssqlite_suser_sname', () => server.current?.userName ?? 'sa', { deterministic: false })
    define('mssqlite_user_name', () => 'dbo', { deterministic: false })
    define('mssqlite_host_name', () => server.current?.hostName ?? hostname(), { deterministic: false })
    define('mssqlite_app_name', () => server.current?.applicationName ?? '', { deterministic: false })
    define('mssqlite_serverproperty', property =>
      property === null ?
        null :
        serverProperties(server)[text(property).toLowerCase()] ?? null, { deterministic: false })
    // ERROR_* read the CATCH-scoped error slot; NULL outside a CATCH block.
    define('mssqlite_error_number', () => server.current?.caughtError?.number ?? null, { deterministic: false })
    define('mssqlite_error_message', () => server.current?.caughtError?.message ?? null, { deterministic: false })
    define('mssqlite_error_severity', () => server.current?.caughtError?.severity ?? null, { deterministic: false })
    define('mssqlite_error_state', () => server.current?.caughtError?.state ?? null, { deterministic: false })
    define('mssqlite_error_line', () => server.current?.caughtError?.line ?? null, { deterministic: false })
    define('mssqlite_error_procedure', () => server.current?.caughtError?.procedure ?? null, { deterministic: false })
    define('mssqlite_xact_state', () => {
      const current = server.current
      return current === undefined || current.transactionCount === 0 ?
        0 :
        current.transactionDoomed ? -1 : 1
    }, { deterministic: false })
  }
