import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dateadd, datediff, datename, datepart, eomonth } from './date-functions.ts'
import * as DecimalExact from './decimal.ts'
import { nextSequenceValue } from './sequence.ts'
import { MssqlError } from './error.ts'
import type { Server } from './session.ts'

type Argument =
  null | number | bigint | string | Uint8Array

const text =
  (value: Argument): string =>
    typeof value === 'string' ? value : String(value ?? '')

const decimalArgument =
  (value: Argument): string | number | bigint | null =>
    value instanceof Uint8Array ? text(value) : value

/** @returns last part of a dotted, optionally bracketed object name. */
const namePart =
  (value: string): string => {
    const parts = value.split('.')
    const last = parts[parts.length - 1] ?? ''
    return last.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '')
  }

/** @returns SQL LIKE pattern body converted to regular expression source. */
const likePatternSource =
  (pattern: string): string => {
    let out = ''
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i] ?? ''
      if (char === '%') {
        out += '[\\s\\S]*'
      } else if (char === '_') {
        out += '[\\s\\S]'
      } else if (char === '[') {
        const end = pattern.indexOf(']', i + 1)
        if (end === -1) {
          out += '\\['
        } else {
          out += `[${pattern.slice(i + 1, end).replaceAll('\\', '\\\\')}]`
          i = end
        }
      } else {
        out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

const integerBounds: Record<string, readonly [ bigint, bigint ]> = {
  tinyint: [ 0n, 255n ],
  smallint: [ -32768n, 32767n ],
  int: [ -2147483648n, 2147483647n ],
  integer: [ -2147483648n, 2147483647n ],
  bigint: [ -9223372036854775808n, 9223372036854775807n ]
}

const castInteger =
  (value: Argument, type: Argument, try_: Argument): Argument => {
    if (value === null) {
      return null
    }
    try {
      let integer: bigint
      if (typeof value === 'bigint') {
        integer = value
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        integer = BigInt(Math.trunc(value))
      } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
        integer = BigInt(value.trim())
      } else {
        throw new MssqlError(
          `Conversion failed when converting the value '${String(value)}' to data type ${text(type)}.`,
          245, 16, 1, { statementTerminating: true })
      }
      const [ minimum, maximum ] = integerBounds[text(type).toLowerCase()] ?? integerBounds['bigint'] as
        readonly [ bigint, bigint ]
      if (integer < minimum || integer > maximum) {
        throw new MssqlError('Arithmetic overflow error converting expression to data type int.',
          8115, 16, 1, { statementTerminating: true })
      }
      return integer >= Number.MIN_SAFE_INTEGER && integer <= Number.MAX_SAFE_INTEGER ?
        Number(integer) :
        integer
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

/**
 * Registers all `mssqlite_*` SQL functions the transpiler emits. Session
 * scoped functions read `server.current`, set by the engine per batch.
 */
export const registerFunctions =
  (server: Server): void => {
    const { db } = server
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
    define('mssqlite_arithmetic', (operator, left, right, width) =>
      checkedArithmetic(server, operator, left, right, width), { deterministic: false })
    define('mssqlite_decimal_cast', (value, precision, scale, try_) =>
      DecimalExact.cast(decimalArgument(value), Number(precision), Number(scale), Number(try_) !== 0))
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
    define('mssqlite_cast_integer', castInteger)
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
    define('mssqlite_right', (value, count) =>
      value === null || count === null ?
        null :
        Number(count) <= 0 ? '' : text(value).slice(-Number(count)))
    define('mssqlite_replicate', (value, count) =>
      value === null || count === null ?
        null :
        text(value).repeat(Math.max(0, Number(count))))
    define('mssqlite_reverse', value =>
      value === null ? null : [ ...text(value) ].reverse().join(''))
    define('mssqlite_stuff', (value, start, length, replacement) => {
      if (value === null || start === null || length === null) {
        return null
      }
      const source = text(value)
      const at = Number(start)
      if (at < 1 || at > source.length) {
        return null
      }
      return source.slice(0, at - 1) + text(replacement ?? '') + source.slice((at - 1) + Number(length))
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
    define('mssqlite_datalength', value =>
      value === null ?
        null :
        typeof value === 'string' ?
          value.length * 2 :
          value instanceof Uint8Array ?
            value.byteLength :
            typeof value === 'bigint' ?
              8 :
              Number.isInteger(value) ? 4 : 8)
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
    define('mssqlite_db_name', () => server.current?.database ?? server.databaseName, { deterministic: false })
    define('mssqlite_db_id', () => 5, { deterministic: false })
    define('mssqlite_scope_identity', () => {
      const identity = server.current?.lastIdentity ?? null
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
