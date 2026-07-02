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
  (parts: Parts): string =>
    `${DateTime.formatDate(parts)} ${DateTime.formatTime(parts, 3)}`

const days =
  (parts: Parts): number =>
    DateTime.daysFromCivil(parts.year, parts.month, parts.day)

const dayTicks =
  (parts: Parts): number =>
    (((((parts.hours * 60) + parts.minutes) * 60) + parts.seconds) * 1000) + Math.round(parts.ticks / 10000)

/** @returns date shifted by `n` of `part`, formatted as an MSSQL datetime string. */
export const dateadd =
  (part: string, n: number, value: string): string => {
    const parts = DateTime.partsOf(value)
    switch (part) {
      case 'year': {
        const year = parts.year + n
        return format({ ...parts, year, day: clampDay(year, parts.month, parts.day) })
      }
      case 'quarter':
      case 'month': {
        const months = (parts.year * 12) + (parts.month - 1) + (part === 'quarter' ? n * 3 : n)
        const year = Math.floor(months / 12)
        const month = (months - (year * 12)) + 1
        return format({ ...parts, year, month, day: clampDay(year, month, parts.day) })
      }
      case 'day':
      case 'dayofyear':
      case 'weekday':
      case 'week': {
        const shift = part === 'week' ? n * 7 : n
        return format({
          ...DateTime.civilFromDays(days(parts) + shift),
          hours: parts.hours,
          minutes: parts.minutes,
          seconds: parts.seconds,
          ticks: parts.ticks
        })
      }
      default: {
        const unit = { hour: 3600000, minute: 60000, second: 1000, millisecond: 1 }[part]
        if (unit === undefined) {
          throw new Error(`Unsupported datepart ${part}.`)
        }
        const total = (days(parts) * 86400000) + dayTicks(parts) + (n * unit)
        const day = Math.floor(total / 86400000)
        let rest = total - (day * 86400000)
        const hours = Math.floor(rest / 3600000)
        rest -= hours * 3600000
        const minutes = Math.floor(rest / 60000)
        rest -= minutes * 60000
        const seconds = Math.floor(rest / 1000)
        return format({
          ...DateTime.civilFromDays(day),
          hours,
          minutes,
          seconds,
          ticks: (rest - (seconds * 1000)) * 10000
        })
      }
    }
  }

/** @returns count of `part` boundaries crossed between two dates, per MSSQL semantics. */
export const datediff =
  (part: string, from: string, to: string): number => {
    const a = DateTime.partsOf(from)
    const b = DateTime.partsOf(to)
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
        const unit = { hour: 3600000, minute: 60000, second: 1000, millisecond: 1 }[part]
        if (unit === undefined) {
          throw new Error(`Unsupported datepart ${part}.`)
        }
        const truncate = (parts: Parts): number => {
          const ticks = dayTicks(parts)
          return ((days(parts) * 86400000) + ticks) - (ticks % unit) - ((days(parts) * 86400000) % unit)
        }
        return Math.round((truncate(b) - truncate(a)) / unit)
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
        return ((days(parts) + 4) % 7) + 1
      case 'hour':
        return parts.hours
      case 'minute':
        return parts.minutes
      case 'second':
        return parts.seconds
      case 'millisecond':
        return Math.round(parts.ticks / 10000)
      case 'microsecond':
        return Math.round(parts.ticks / 10)
      case 'nanosecond':
        return parts.ticks * 100
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
