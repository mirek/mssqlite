import { TypeInfo, Value as TdsValue } from '@mssqlite/tds'
import { MssqlError } from './error.ts'
import type { Value } from './session.ts'

const conversion =
  (value: Value, target: string, number = 245): MssqlError =>
    new MssqlError(
      number === 8114 ? `Error converting data type varchar to ${target}.` :
        `Conversion failed when converting the value '${String(value)}' to data type ${target}.`,
      number, 16, 1, { statementTerminating: true })

const truncatedDecimal =
  (source: string): bigint | undefined => {
    const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source)
    if (match === null) {
      return undefined
    }
    const sign = match[1] === '-' ? '-' : ''
    const whole = match[2] ?? ''
    const fraction = match[3] ?? ''
    const decimalAt = whole.length + Number(match[4] ?? 0)
    if (decimalAt <= 0) {
      return 0n
    }
    const digits = `${whole}${fraction}`.slice(0, decimalAt).padEnd(decimalAt, '0')
    return BigInt(`${sign}${digits || '0'}`)
  }

/** @returns strict bounded SQL integer conversion. */
export const integer =
  (value: Value, target: string, numericSource = false): Value => {
    if (value === null) {
      return null
    }
    let result: bigint
    if (typeof value === 'bigint') {
      result = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result = BigInt(Math.trunc(value))
    } else if (typeof value === 'string' && value.trim() === '') {
      result = 0n
    } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
      result = BigInt(value.trim())
    } else if (typeof value === 'string' && numericSource) {
      const truncated = truncatedDecimal(value.trim())
      if (truncated === undefined) {
        throw conversion(value, target)
      }
      result = truncated
    } else if (value instanceof Uint8Array) {
      return binaryInteger(value, target)
    } else {
      throw conversion(value, target)
    }
    const bounds: Readonly<Record<string, readonly [ bigint, bigint ]>> = {
      tinyint: [ 0n, 255n ],
      smallint: [ -32768n, 32767n ],
      int: [ -2147483648n, 2147483647n ],
      integer: [ -2147483648n, 2147483647n ],
      bigint: [ -9223372036854775808n, 9223372036854775807n ]
    }
    const [ minimum, maximum ] = bounds[target] ?? bounds['bigint'] as readonly [ bigint, bigint ]
    if (result < minimum || result > maximum) {
      throw new MssqlError('Arithmetic overflow error converting expression to data type int.',
        8115, 16, 1, { statementTerminating: true })
    }
    return result >= Number.MIN_SAFE_INTEGER && result <= Number.MAX_SAFE_INTEGER ? Number(result) : result
  }

/** @returns strict SQL bit conversion. */
export const bit =
  (value: Value): Value => {
    if (value === null) {
      return null
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      return value === 0 || value === 0n ? 0 : 1
    }
    if (typeof value === 'string') {
      const source = value.trim().toLowerCase()
      if (source === 'true' || source === 'false') {
        return source === 'true' ? 1 : 0
      }
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source)) {
        return Number(source) === 0 ? 0 : 1
      }
    }
    throw conversion(value, 'bit')
  }

/** @returns strict SQL real/float conversion. */
export const real =
  (value: Value, target: string): Value => {
    if (value === null) {
      return null
    }
    const result = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value)
    if (!Number.isFinite(result)) {
      throw conversion(value, target, 8114)
    }
    return result
  }

const dateParts =
  (value: string): readonly [ string, string ] | undefined => {
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?$/.exec(value)
    if (match === null) {
      return undefined
    }
    const [ , year_, month_, day_, hour_ = '00', minute_ = '00', second_ = '00', fraction_ = '' ] = match
    const year = Number(year_)
    const month = Number(month_)
    const day = Number(day_)
    const hour = Number(hour_)
    const minute = Number(minute_)
    const second = Number(second_)
    const date = new Date(Date.UTC(year, month - 1, day))
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
      return undefined
    }
    const fraction = fraction_.length === 0 ? '' : `.${fraction_}`
    return [ `${year_}-${month_}-${day_}`, `${hour_}:${minute_}:${second_}${fraction}` ]
  }

/** @returns normalized ISO temporal text or SQL error 241. */
export const temporal =
  (value: Value, target: string): Value => {
    if (value === null) {
      return null
    }
    const source = String(value).trim()
    if (target === 'time') {
      const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/.exec(source)
      if (match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3] ?? 0) <= 59) {
        const fraction = match[4] === undefined ? '' : `.${match[4]}`
        return `${match[1]}:${match[2]}:${match[3] ?? '00'}${fraction}`
      }
    } else {
      const parts = dateParts(source)
      if (parts !== undefined) {
        const time = parts[1].includes('.') ? parts[1] : `${parts[1]}.000`
        return target === 'date' ? parts[0] : `${parts[0]} ${time}`
      }
    }
    throw new MssqlError(
      'Conversion failed when converting date and/or time from character string.',
      241, 16, 1, { statementTerminating: true })
  }

/** @returns canonical uniqueidentifier text or SQL error 8169. */
export const guid =
  (value: Value): Value => {
    if (value === null) {
      return null
    }
    if (value instanceof Uint8Array && value.byteLength === 16) {
      return String(TdsValue.decodeBare(TypeInfo.guid(), value))
    }
    const source = String(value).trim().replace(/^\{(.*)\}$/, '$1')
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source)) {
      throw new MssqlError(
        'Conversion failed when converting from a character string to uniqueidentifier.',
        8169, 16, 1, { statementTerminating: true })
    }
    return source.toUpperCase()
  }

/** @returns a big-endian binary value converted to the requested integer width. */
export const binaryInteger =
  (value: Value, target: string): Value => {
    if (value === null) {
      return null
    }
    if (!(value instanceof Uint8Array)) {
      throw conversion(value, target)
    }
    let result = 0n
    for (const byte of value) {
      result = (result << 8n) | BigInt(byte)
    }
    const bounds: Readonly<Record<string, readonly [ bigint, bigint ]>> = {
      tinyint: [ 0n, 255n ],
      smallint: [ -32768n, 32767n ],
      int: [ -2147483648n, 2147483647n ],
      bigint: [ -9223372036854775808n, 9223372036854775807n ]
    }
    const [ minimum, maximum ] = bounds[target] ?? bounds['bigint'] as readonly [ bigint, bigint ]
    if (result < minimum || result > maximum) {
      throw new MssqlError('Arithmetic overflow error converting expression to data type int.',
        8115, 16, 1, { statementTerminating: true })
    }
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result) : result
  }

/** @returns concatenated binary operands. */
export const binaryConcat =
  (left: Value, right: Value): Value => {
    if (left === null || right === null) {
      return null
    }
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) {
      throw new MssqlError('The data types are incompatible in the add operator.',
        402, 16, 1, { statementTerminating: true })
    }
    const result = new Uint8Array(left.byteLength + right.byteLength)
    result.set(left)
    result.set(right, left.byteLength)
    return result
  }
