import { DateTime, TypeInfo, Value as TdsValue } from '@mssqlite/tds'
import { MssqlError } from './error.ts'

/** Canonical fixed-scale datetimeoffset cast through the TDS codec. */
export const cast =
  (value: string | null, scale: number, try_: boolean): string | null => {
    if (!Number.isInteger(scale) || scale < 0 || scale > 7) {
      throw new MssqlError(
        `The number (${scale}) in type 'datetimeoffset' is out of range. The maximum allowed is 7.`,
        1005, 15, 2)
    }
    if (value === null) {
      return null
    }
    try {
      const type = TypeInfo.datetimeOffsetN(scale)
      return String(TdsValue.decodeBare(type, TdsValue.encodeBare(type, value)))
    } catch (error) {
      if (try_) {
        return null
      }
      throw new MssqlError(
        `Conversion failed when converting date and/or time from character string. ${String(error)}`,
        241, 16, 1, { statementTerminating: true })
    }
  }

/** UTC-normalized lexical key while retaining 100ns precision. */
export const key =
  (value: string | null): string | null => {
    if (value === null) {
      return null
    }
    const parts = DateTime.partsOf(value)
    const utc = DateTime.shifted(parts, -(parts.offsetMinutes ?? 0))
    const day = DateTime.daysFromCivil(utc.year, utc.month, utc.day) + DateTime.epochDays0001
    const ticks = (((((utc.hours * 60) + utc.minutes) * 60) + utc.seconds) * 10000000) + utc.ticks
    return `${String(day).padStart(7, '0')}:${String(ticks).padStart(12, '0')}`
  }
