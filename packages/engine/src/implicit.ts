import { DateTime, TypeInfo, Value as TdsValue } from '@mssqlite/tds'
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
    const roundTrip = DateTime.civilFromDays(DateTime.daysFromCivil(year, month, day))
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 ||
      roundTrip.year !== year || roundTrip.month !== month || roundTrip.day !== day ||
      hour > 23 || minute > 59 || second > 59) {
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

/** @returns strict temporal conversion, or NULL for a TRY conversion failure. */
export const tryTemporal =
  (value: Value, target: string, try_: boolean): Value => {
    try {
      return temporal(value, target)
    } catch (error) {
      if (try_) {
        return null
      }
      throw error
    }
  }

const constructorPart =
  (value: Value): number =>
    Number(integer(value, 'int', true))

const validCivilDate =
  (year: number, month: number, day: number): boolean => {
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) {
      return false
    }
    const result = DateTime.civilFromDays(DateTime.daysFromCivil(year, month, day))
    return result.year === year && result.month === month && result.day === day
  }

const constructorError =
  (type: 'date' | 'datetime'): MssqlError =>
    new MssqlError(
      `Cannot construct data type ${type}, some of the arguments have values which are not valid.`,
      289, 16, type === 'datetime' ? 3 : 1, { statementTerminating: true })

const roundedDateTime =
  (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    millisecond: number
  ): string | undefined => {
    const thirdsPerDay = 25920000
    const inputMinutes = (hour * 60) + minute
    const inputSeconds = (inputMinutes * 60) + second
    const inputMilliseconds = (inputSeconds * 1000) + millisecond
    const thirds = Math.round(inputMilliseconds * 3 / 10)
    const carry = Math.floor(thirds / thirdsPerDay)
    const inDay = thirds - (carry * thirdsPerDay)
    const outputMilliseconds = Math.round(inDay * 10 / 3)
    const civil = DateTime.civilFromDays(DateTime.daysFromCivil(year, month, day) + carry)
    if (civil.year < 1753 || civil.year > 9999) {
      return undefined
    }
    const outputSeconds = Math.floor(outputMilliseconds / 1000)
    return `${DateTime.formatDate(civil)} ` +
      `${String(Math.floor(outputSeconds / 3600)).padStart(2, '0')}:` +
      `${String(Math.floor(outputSeconds / 60) % 60).padStart(2, '0')}:` +
      `${String(outputSeconds % 60).padStart(2, '0')}.` +
      `${String(outputMilliseconds % 1000).padStart(3, '0')}`
  }

/** @returns a validated DATEFROMPARTS value. */
export const dateFromParts =
  (year_: Value, month_: Value, day_: Value): Value => {
    if (year_ === null || month_ === null || day_ === null) {
      return null
    }
    const year = constructorPart(year_)
    const month = constructorPart(month_)
    const day = constructorPart(day_)
    if (!validCivilDate(year, month, day)) {
      throw constructorError('date')
    }
    return DateTime.formatDate({ year, month, day })
  }

/** @returns a validated DATETIMEFROMPARTS value. */
export const datetimeFromParts =
  (
    year_: Value,
    month_: Value,
    day_: Value,
    hour_: Value,
    minute_: Value,
    second_: Value,
    millisecond_: Value
  ): Value => {
    const values = [ year_, month_, day_, hour_, minute_, second_, millisecond_ ]
    if (values.some(value => value === null)) {
      return null
    }
    const [ year, month, day, hour, minute, second, millisecond ] =
      values.map(value => constructorPart(value)) as [ number, number, number, number, number, number, number ]
    if (!validCivilDate(year, month, day) || year < 1753 || hour < 0 || hour > 23 || minute < 0 ||
      minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999) {
      throw constructorError('datetime')
    }
    const result = roundedDateTime(year, month, day, hour, minute, second, millisecond)
    if (result === undefined) {
      throw constructorError('datetime')
    }
    return result
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
