import { Encode } from '@mssqlite/bytes'
import * as DataType from './data-type.ts'

/** Broken-down date and time — `ticks` are 100ns units within the second. */
export type Parts = {
  readonly year: number,
  readonly month: number,
  readonly day: number,
  readonly hours: number,
  readonly minutes: number,
  readonly seconds: number,
  readonly ticks: number,
  readonly offsetMinutes?: number
}

export type t =
  Parts

/** Days between 0001-01-01 and 1970-01-01 in the proleptic Gregorian calendar. */
export const epochDays0001 = 719162

/** Days between 1900-01-01 and 1970-01-01. */
export const epochDays1900 = 25567

/** @returns days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
export const daysFromCivil =
  (year: number, month: number, day: number): number => {
    const y = year - (month <= 2 ? 1 : 0)
    const era = Math.floor(y / 400)
    const yoe = y - (era * 400)
    const doy = Math.floor(((153 * (month + (month > 2 ? -3 : 9))) + 2) / 5) + day - 1
    const doe = (yoe * 365) + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
    return (era * 146097) + doe - 719468
  }

/** @returns civil date for days since 1970-01-01. */
export const civilFromDays =
  (days: number): { year: number, month: number, day: number } => {
    const z = days + 719468
    const era = Math.floor(z / 146097)
    const doe = z - (era * 146097)
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
    const y = yoe + (era * 400)
    const doy = doe - ((365 * yoe) + Math.floor(yoe / 4) - Math.floor(yoe / 100))
    const mp = Math.floor(((5 * doy) + 2) / 153)
    const day = doy - Math.floor(((153 * mp) + 2) / 5) + 1
    const month = mp < 10 ? mp + 3 : mp - 9
    return { year: y + (month <= 2 ? 1 : 0), month, day }
  }

const pattern =
  /^(?:(\d{4})-(\d{2})-(\d{2}))?(?:(?:^|[T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?(?:\s*(Z|[+-]\d{2}:\d{2}))?$/

/**
 * @returns parts parsed from a `YYYY-MM-DD[ HH:MM[:SS[.fffffff]]][±HH:MM]`
 * or time-only `HH:MM[:SS[.fffffff]]` string, or a `Date` (UTC).
 * Time-only values default to the 1900-01-01 date MSSQL uses.
 */
export const partsOf =
  (value: Date | string): Parts => {
    if (value instanceof Date) {
      return {
        year: value.getUTCFullYear(),
        month: value.getUTCMonth() + 1,
        day: value.getUTCDate(),
        hours: value.getUTCHours(),
        minutes: value.getUTCMinutes(),
        seconds: value.getUTCSeconds(),
        ticks: value.getUTCMilliseconds() * 10000
      }
    }
    const match = pattern.exec(value.trim())
    if (!match || (match[1] === undefined && match[4] === undefined)) {
      throw new Error(`Invalid date/time value ${JSON.stringify(value)}.`)
    }
    const [ , year, month, day, hours, minutes, seconds, fraction, zone ] = match
    const parts: Parts = {
      year: Number(year ?? 1900),
      month: Number(month ?? 1),
      day: Number(day ?? 1),
      hours: Number(hours ?? 0),
      minutes: Number(minutes ?? 0),
      seconds: Number(seconds ?? 0),
      ticks: fraction === undefined ? 0 : Number(fraction.padEnd(7, '0'))
    }
    const validMonth = parts.month >= 1 && parts.month <= 12
    const next = parts.month === 12 ? { year: parts.year + 1, month: 1 } :
      { year: parts.year, month: parts.month + 1 }
    const daysInMonth = validMonth ?
      daysFromCivil(next.year, next.month, 1) - daysFromCivil(parts.year, parts.month, 1) : 0
    if (parts.year < 1 || parts.year > 9999 || !validMonth ||
      parts.day < 1 || parts.day > daysInMonth ||
      parts.hours > 23 || parts.minutes > 59 || parts.seconds > 59) {
      throw new Error(`Invalid date/time value ${JSON.stringify(value)}.`)
    }
    if (zone !== undefined && zone !== 'Z') {
      const sign = zone.startsWith('-') ? -1 : 1
      const offsetHours = Number(zone.slice(1, 3))
      const offsetMinutePart = Number(zone.slice(4, 6))
      const offsetMinutes = sign * ((offsetHours * 60) + offsetMinutePart)
      if (offsetMinutePart > 59 || offsetHours > 14 || (offsetHours === 14 && offsetMinutePart !== 0)) {
        throw new Error(`Invalid datetimeoffset zone ${zone}.`)
      }
      return { ...parts, offsetMinutes }
    }
    return zone === 'Z' ? { ...parts, offsetMinutes: 0 } : parts
  }

const pad =
  (value: number, length: number): string =>
    String(value).padStart(length, '0')

/** @returns `YYYY-MM-DD` string. */
export const formatDate =
  (parts: Pick<Parts, 'year' | 'month' | 'day'>): string =>
    `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`

/** @returns `HH:MM:SS[.fff...]` string with `scale` fraction digits. */
export const formatTime =
  (parts: Pick<Parts, 'hours' | 'minutes' | 'seconds' | 'ticks'>, scale: number): string => {
    const base = `${pad(parts.hours, 2)}:${pad(parts.minutes, 2)}:${pad(parts.seconds, 2)}`
    return scale === 0 ?
      base :
      `${base}.${pad(parts.ticks, 7).slice(0, scale)}`
  }

/** @returns seconds since midnight (fraction excluded). */
const daySeconds =
  (parts: Parts): number =>
    (parts.hours * 3600) + (parts.minutes * 60) + parts.seconds

/** @returns parts shifted by `minutes` (used to convert between UTC and offset-local). */
export const shifted =
  (parts: Parts, minutes: number): Parts => {
    const total = (daysFromCivil(parts.year, parts.month, parts.day) * 1440) +
      (parts.hours * 60) + parts.minutes + minutes
    const days = Math.floor(total / 1440)
    const dayMinutes = total - (days * 1440)
    return {
      ...civilFromDays(days),
      hours: Math.floor(dayMinutes / 60),
      minutes: dayMinutes % 60,
      seconds: parts.seconds,
      ticks: parts.ticks
    }
  }

/** @returns 8 datetime bytes — days since 1900-01-01 (int32) and 1/300s since midnight (uint32). */
export const encodeDateTime =
  (parts: Parts): Uint8Array => {
    const days = daysFromCivil(parts.year, parts.month, parts.day) + epochDays1900
    const third = Math.round(((daySeconds(parts) * 10000000) + parts.ticks) * 300 / 10000000)
    return Encode.concat(Encode.int32(days), Encode.uint32(third))
  }

/** @returns `YYYY-MM-DD HH:MM:SS.fff` string from datetime wire parts. */
export const decodeDateTime =
  (days: number, third: number): string => {
    const milliseconds = Math.round(third * 10 / 3)
    const seconds = Math.floor(milliseconds / 1000)
    const parts = {
      ...civilFromDays(days - epochDays1900),
      hours: Math.floor(seconds / 3600),
      minutes: Math.floor(seconds / 60) % 60,
      seconds: seconds % 60,
      ticks: (milliseconds % 1000) * 10000
    }
    return `${formatDate(parts)} ${formatTime(parts, 3)}`
  }

/** @returns 4 smalldatetime bytes — days since 1900-01-01 (uint16) and minutes since midnight (uint16). */
export const encodeSmallDateTime =
  (parts: Parts): Uint8Array => {
    const days = daysFromCivil(parts.year, parts.month, parts.day) + epochDays1900
    const minutes = (parts.hours * 60) + parts.minutes + (parts.seconds >= 30 ? 1 : 0)
    return Encode.concat(Encode.uint16(days), Encode.uint16(minutes))
  }

/** @returns `YYYY-MM-DD HH:MM:00` string from smalldatetime wire parts. */
export const decodeSmallDateTime =
  (days: number, minutes: number): string => {
    const parts = {
      ...civilFromDays(days - epochDays1900),
      hours: Math.floor(minutes / 60),
      minutes: minutes % 60,
      seconds: 0,
      ticks: 0
    }
    return `${formatDate(parts)} ${formatTime(parts, 0)}`
  }

/** @returns 3 date bytes — days since 0001-01-01 (little-endian). */
export const encodeDate =
  (parts: Parts): Uint8Array =>
    Encode.uintLe(daysFromCivil(parts.year, parts.month, parts.day) + epochDays0001, 3)

/** @returns `YYYY-MM-DD` string from days since 0001-01-01. */
export const decodeDate =
  (days: number): string =>
    formatDate(civilFromDays(days - epochDays0001))

/** @returns time ticks since midnight in 10^-scale second units. */
const timeUnits =
  (parts: Parts, scale: number): number => {
    if (!Number.isInteger(scale) || scale < 0 || scale > 7) {
      throw new RangeError(`Invalid date/time scale ${scale}; expected 0 through 7.`)
    }
    return Math.round(((daySeconds(parts) * 10000000) + parts.ticks) / (10 ** (7 - scale))) %
      (86400 * (10 ** scale))
  }

const rounded =
  (parts: Parts, scale: number): Parts => {
    if (!Number.isInteger(scale) || scale < 0 || scale > 7) {
      throw new RangeError(`Invalid date/time scale ${scale}; expected 0 through 7.`)
    }
    const unitsPerDay = 86400 * (10 ** scale)
    const units = Math.round(((daySeconds(parts) * 10000000) + parts.ticks) / (10 ** (7 - scale)))
    const carry = Math.floor(units / unitsPerDay)
    return {
      ...parts,
      ...civilFromDays(daysFromCivil(parts.year, parts.month, parts.day) + carry),
      ...timeParts(units % unitsPerDay, scale)
    }
  }

/** @returns time(n) bytes — 3-5 byte little-endian tick count. */
export const encodeTime =
  (parts: Parts, scale: number): Uint8Array =>
    Encode.uintLe(timeUnits(parts, scale), DataType.timeLength(scale))

/** @returns time parts from ticks in 10^-scale second units. */
const timeParts =
  (units: number, scale: number): Pick<Parts, 'hours' | 'minutes' | 'seconds' | 'ticks'> => {
    const ticks = units * (10 ** (7 - scale))
    const seconds = Math.floor(ticks / 10000000)
    return {
      hours: Math.floor(seconds / 3600),
      minutes: Math.floor(seconds / 60) % 60,
      seconds: seconds % 60,
      ticks: ticks % 10000000
    }
  }

/** @returns `HH:MM:SS[.f...]` string from time(n) wire ticks. */
export const decodeTime =
  (units: number, scale: number): string =>
    formatTime(timeParts(units, scale), scale)

/** @returns datetime2(n) bytes — time(n) followed by 3 date bytes. */
export const encodeDateTime2 =
  (parts: Parts, scale: number): Uint8Array => {
    const value = rounded(parts, scale)
    if (value.year < 1 || value.year > 9999) {
      throw new Error('The rounded datetime2 value is outside 0001-01-01 through 9999-12-31.')
    }
    return Encode.concat(encodeTime(value, scale), encodeDate(value))
  }

/** @returns `YYYY-MM-DD HH:MM:SS[.f...]` string from datetime2(n) wire parts. */
export const decodeDateTime2 =
  (units: number, days: number, scale: number): string =>
    `${decodeDate(days)} ${decodeTime(units, scale)}`

/**
 * @returns datetimeoffset(n) bytes — UTC time(n) and date, then offset minutes (int16).
 * Parts are interpreted as local to their `offsetMinutes` (0 when absent).
 */
export const encodeDateTimeOffset =
  (parts: Parts, scale: number): Uint8Array => {
    const offsetMinutes = parts.offsetMinutes ?? 0
    const local = rounded(parts, scale)
    if (local.year < 1 || local.year > 9999) {
      throw new Error('The rounded local datetimeoffset value is outside 0001-01-01 through 9999-12-31.')
    }
    const utc = shifted(local, -offsetMinutes)
    if (utc.year < 1 || utc.year > 9999) {
      throw new Error('The UTC datetimeoffset instant is outside 0001-01-01 through 9999-12-31.')
    }
    return Encode.concat(encodeTime(utc, scale), encodeDate(utc), Encode.int16(offsetMinutes))
  }

/** @returns `YYYY-MM-DD HH:MM:SS[.f...] ±HH:MM` string from datetimeoffset(n) wire parts. */
export const decodeDateTimeOffset =
  (units: number, days: number, offsetMinutes: number, scale: number): string => {
    const utc = {
      ...civilFromDays(days - epochDays0001),
      ...timeParts(units, scale)
    }
    const local = shifted(utc, offsetMinutes)
    const sign = offsetMinutes < 0 ? '-' : '+'
    const magnitude = Math.abs(offsetMinutes)
    const zone = `${sign}${pad(Math.floor(magnitude / 60), 2)}:${pad(magnitude % 60, 2)}`
    return `${formatDate(local)} ${formatTime(local, scale)} ${zone}`
  }
