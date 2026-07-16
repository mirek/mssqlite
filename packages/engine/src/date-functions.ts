import { DateTime } from '@mssqlite/tds'

type Parts = DateTime.Parts

const monthNames = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
] as const

const weekdayNames = [
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'
] as const

const clampDay =
  (year: number, month: number, day: number): number => {
    const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
    const last = DateTime.daysFromCivil(next.year, next.month, 1) - DateTime.daysFromCivil(year, month, 1)
    return Math.min(day, last)
  }

const format =
  (parts: Parts, scale = 3): string => {
    if (parts.year < 1 || parts.year > 9999) {
      throw new Error('Adding a value to a date caused an overflow.')
    }
    if (parts.offsetMinutes !== undefined) {
      const utc = DateTime.shifted(parts, -parts.offsetMinutes)
      if (utc.year < 1 || utc.year > 9999) {
        throw new Error('Adding a value to a datetimeoffset caused a UTC overflow.')
      }
    }
    const value = `${DateTime.formatDate(parts)} ${DateTime.formatTime(parts, scale)}`
    if (parts.offsetMinutes === undefined) {
      return value
    }
    const sign = parts.offsetMinutes < 0 ? '-' : '+'
    const offset = Math.abs(parts.offsetMinutes)
    return `${value} ${sign}${String(Math.floor(offset / 60)).padStart(2, '0')}:` +
      `${String(offset % 60).padStart(2, '0')}`
  }

const scaleOf =
  (value: string): number =>
    /\.(\d{1,7})/.exec(value)?.[1]?.length ?? 0

const days =
  (parts: Parts): number =>
    DateTime.daysFromCivil(parts.year, parts.month, parts.day)

const ticksPerDay = 864000000000n

const exactDayTicks =
  (parts: Parts): bigint =>
    (BigInt((((parts.hours * 60) + parts.minutes) * 60) + parts.seconds) * 10000000n) +
    BigInt(parts.ticks)

const exactParts =
  (parts: Parts, delta: bigint): Parts => {
    const total = exactDayTicks(parts) + delta
    const carry = total >= 0n ? total / ticksPerDay : ((total + 1n) / ticksPerDay) - 1n
    const rest = total - (carry * ticksPerDay)
    const civil = DateTime.civilFromDays(days(parts) + Number(carry))
    if (civil.year < 1 || civil.year > 9999) {
      throw new Error('Adding a value to a date caused an overflow.')
    }
    const seconds = rest / 10000000n
    return {
      ...civil,
      hours: Number(seconds / 3600n),
      minutes: Number((seconds / 60n) % 60n),
      seconds: Number(seconds % 60n),
      ticks: Number(rest % 10000000n),
      ...parts.offsetMinutes === undefined ? {} : { offsetMinutes: parts.offsetMinutes }
    }
  }

const nanosecondTicks =
  (value: number): bigint =>
    BigInt(value >= 0 ? Math.floor((Math.trunc(value) + 50) / 100) :
      Math.ceil((Math.trunc(value) - 50) / 100))

/** @returns date shifted by `n` of `part`, formatted as an MSSQL datetime string. */
export const dateadd =
  (part: string, n: number, value: string): string => {
    const parts = DateTime.partsOf(value)
    const scale = parts.offsetMinutes === undefined ? 3 : scaleOf(value)
    const amount = Math.trunc(n)
    switch (part) {
      case 'year': {
        const year = parts.year + amount
        return format({ ...parts, year, day: clampDay(year, parts.month, parts.day) }, scale)
      }
      case 'quarter':
      case 'month': {
        const months = (parts.year * 12) + (parts.month - 1) +
          (part === 'quarter' ? amount * 3 : amount)
        const year = Math.floor(months / 12)
        const month = (months - (year * 12)) + 1
        return format({ ...parts, year, month, day: clampDay(year, month, parts.day) }, scale)
      }
      case 'day':
      case 'dayofyear':
      case 'weekday':
      case 'week': {
        const shift = part === 'week' ? amount * 7 : amount
        return format({
          ...parts,
          ...DateTime.civilFromDays(days(parts) + shift),
          hours: parts.hours,
          minutes: parts.minutes,
          seconds: parts.seconds,
          ticks: parts.ticks
        }, scale)
      }
      default: {
        const exactUnit = {
          hour: 36000000000n,
          minute: 600000000n,
          second: 10000000n,
          millisecond: 10000n,
          microsecond: 10n
        }[part]
        if (exactUnit !== undefined) {
          return format(exactParts(parts, BigInt(amount) * exactUnit), scale)
        }
        if (part === 'nanosecond') {
          return format(exactParts(parts, nanosecondTicks(amount)), scale)
        }
        throw new Error(`Unsupported datepart ${part}.`)
      }
    }
  }

/** @returns count of `part` boundaries crossed between two dates, per MSSQL semantics. */
export const datediff =
  (part: string, from: string, to: string): number => {
    const parsedA = DateTime.partsOf(from)
    const parsedB = DateTime.partsOf(to)
    const a = parsedA.offsetMinutes === undefined ? parsedA :
      DateTime.shifted(parsedA, -parsedA.offsetMinutes)
    const b = parsedB.offsetMinutes === undefined ? parsedB :
      DateTime.shifted(parsedB, -parsedB.offsetMinutes)
    switch (part) {
      case 'year':
        return b.year - a.year
      case 'quarter':
        return ((b.year - a.year) * 4) + (Math.floor((b.month - 1) / 3) - Math.floor((a.month - 1) / 3))
      case 'month':
        return ((b.year - a.year) * 12) + (b.month - a.month)
      case 'day':
      case 'dayofyear':
        return days(b) - days(a)
      case 'week':
        // Boundary is Sunday with the default DATEFIRST 7; 1970-01-01 was a Thursday.
        return Math.floor((days(b) + 4) / 7) - Math.floor((days(a) + 4) / 7)
      default: {
        const unit = {
          hour: 36000000000n,
          minute: 600000000n,
          second: 10000000n,
          millisecond: 10000n,
          microsecond: 10n,
          nanosecond: 1n
        }[part]
        if (unit === undefined) {
          throw new Error(`Unsupported datepart ${part}.`)
        }
        const boundary = (parts: Parts): bigint =>
          ((BigInt(days(parts) + DateTime.epochDays0001) * ticksPerDay) + exactDayTicks(parts)) / unit
        const difference = boundary(b) - boundary(a)
        return Number(part === 'nanosecond' ? difference * 100n : difference)
      }
    }
  }

/** @returns numeric part of a date, per DATEPART. */
export const datepart =
  (part: string, value: string): number => {
    const parts = DateTime.partsOf(value)
    switch (part) {
      case 'year':
        return parts.year
      case 'quarter':
        return Math.floor((parts.month - 1) / 3) + 1
      case 'month':
        return parts.month
      case 'day':
        return parts.day
      case 'dayofyear':
        return days(parts) - DateTime.daysFromCivil(parts.year, 1, 1) + 1
      case 'week':
        return Math.floor((days(parts) - DateTime.daysFromCivil(parts.year, 1, 1) + 7) / 7)
      case 'weekday':
        // 1 = Sunday with the default DATEFIRST 7; 1970-01-01 was a Thursday.
        // Double-mod keeps the result in 1..7 for pre-epoch (negative) days.
        return ((((days(parts) + 4) % 7) + 7) % 7) + 1
      case 'hour':
        return parts.hours
      case 'minute':
        return parts.minutes
      case 'second':
        return parts.seconds
      case 'millisecond':
        return Math.floor(parts.ticks / 10000)
      case 'microsecond':
        return Math.floor(parts.ticks / 10)
      case 'nanosecond':
        return parts.ticks * 100
      case 'tzoffset':
        return parts.offsetMinutes ?? 0
      default:
        throw new Error(`Unsupported datepart ${part}.`)
    }
  }

/** @returns named part of a date, per DATENAME. */
export const datename =
  (part: string, value: string): string => {
    const parts = DateTime.partsOf(value)
    switch (part) {
      case 'month':
        return monthNames[parts.month - 1] ?? ''
      case 'weekday':
        return weekdayNames[((days(parts) % 7) + 10) % 7] ?? ''
      case 'tzoffset': {
        const offset = parts.offsetMinutes ?? 0
        const sign = offset < 0 ? '-' : '+'
        return `${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:` +
          `${String(Math.abs(offset) % 60).padStart(2, '0')}`
      }
      default:
        return String(datepart(part, value))
    }
  }

/** @returns last day of the month `n` months from a date, as `YYYY-MM-DD`. */
export const eomonth =
  (value: string, n: number): string => {
    const parts = DateTime.partsOf(value)
    const months = (parts.year * 12) + (parts.month - 1) + n + 1
    const year = Math.floor(months / 12)
    const month = (months - (year * 12)) + 1
    return DateTime.formatDate(DateTime.civilFromDays(DateTime.daysFromCivil(year, month, 1) - 1))
  }
