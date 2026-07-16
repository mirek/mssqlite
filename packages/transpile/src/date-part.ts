import type { Ast } from '@mssqlite/tsql'

const parts: Record<string, string> = {
  year: 'year', yy: 'year', yyyy: 'year',
  quarter: 'quarter', qq: 'quarter', q: 'quarter',
  month: 'month', mm: 'month', m: 'month',
  dayofyear: 'dayofyear', dy: 'dayofyear', y: 'dayofyear',
  day: 'day', dd: 'day', d: 'day',
  week: 'week', wk: 'week', ww: 'week',
  weekday: 'weekday', dw: 'weekday',
  hour: 'hour', hh: 'hour',
  minute: 'minute', mi: 'minute', n: 'minute',
  second: 'second', ss: 'second', s: 'second',
  millisecond: 'millisecond', ms: 'millisecond',
  microsecond: 'microsecond', mcs: 'microsecond',
  nanosecond: 'nanosecond', ns: 'nanosecond',
  tzoffset: 'tzoffset', tz: 'tzoffset'
} as const

/**
 * @returns canonical datepart name of the first DATEADD/DATEDIFF/DATEPART
 * argument — parsed as a bare column reference — or `undefined`.
 */
export const datePart =
  (expression: Ast.Expression): string | undefined => {
    if (expression.kind === 'column' && expression.name.length === 1) {
      return parts[(expression.name[0] ?? '').toLowerCase()]
    }
    if (expression.kind === 'string') {
      return parts[expression.value.toLowerCase()]
    }
    return undefined
  }

export default datePart
