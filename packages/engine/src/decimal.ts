import { Decimal } from '@mssqlite/tds'
import { MssqlError } from './error.ts'

const power =
  (n: number): bigint =>
    10n ** BigInt(n)

const signed =
  (value: string | number | bigint, scale: number): bigint => {
    const parsed = Decimal.parse(value, scale)
    return parsed.negative ? -parsed.magnitude : parsed.magnitude
  }

/** Exact comparison after aligning both fixed scales. */
export const compare =
  (
    left: string | number | bigint | null,
    right: string | number | bigint | null,
    leftScale: number,
    rightScale: number
  ): number | null => {
    if (left === null || right === null) {
      return null
    }
    const common = Math.max(leftScale, rightScale)
    const a = rescale(signed(left, leftScale), leftScale, common)
    const b = rescale(signed(right, rightScale), rightScale, common)
    return a < b ? -1 : a > b ? 1 : 0
  }

/** Lexically sortable key for every signed DECIMAL(38, s) value. */
export const sortKey =
  (value: string | number | bigint | null, scale: number): string | null => {
    if (value === null) {
      return null
    }
    return (signed(value, scale) + power(38)).toString().padStart(39, '0')
  }

/** Aggregate state retaining the exact lesser/greater decimal value. */
export const extremumStep =
  (state: string, value: string | number | bigint | null, scale: number, maximum: boolean): string => {
    if (value === null) {
      return state
    }
    if (state === 'empty') {
      return String(value)
    }
    const comparison = compare(value, state, scale, scale) ?? 0
    return maximum ? comparison > 0 ? String(value) : state : comparison < 0 ? String(value) : state
  }

/** Aggregate state for exact SUM/AVG without crossing JavaScript Number. */
export const aggregateStep =
  (
    state: string,
    value: string | number | bigint | null,
    inputScale: number,
    precision: number,
    scale: number
  ): string => {
    if (value === null) {
      return state
    }
    const [ , count = '0', total = '0' ] = state === 'empty' ? [] : state.split('|')
    const next = BigInt(total) + signed(value, inputScale)
    return `${precision},${scale},${inputScale}|${Number(count) + 1}|${next}`
  }

/** Finalizes exact SUM or AVG aggregate state to a canonical fixed-scale string. */
export const aggregateResult =
  (state: string, average: boolean): string | null => {
    if (state === 'empty') {
      return null
    }
    const [ shape = '', count = '0', total = '0' ] = state.split('|')
    const [ precision = 18, scale = 0, inputScale = 0 ] = shape.split(',').map(Number)
    const summed = BigInt(total)
    const result = average ?
      divideRounded(summed * power(scale), BigInt(count) * power(inputScale)) :
      rescale(summed, inputScale, scale)
    return format(result, precision, scale)
  }

const divideRounded =
  (numerator: bigint, denominator: bigint): bigint => {
    const negative = (numerator < 0n) !== (denominator < 0n)
    const a = numerator < 0n ? -numerator : numerator
    const b = denominator < 0n ? -denominator : denominator
    const quotient = a / b
    const rounded = quotient + ((a % b) * 2n >= b ? 1n : 0n)
    return negative ? -rounded : rounded
  }

const rescale =
  (value: bigint, from: number, to: number): bigint =>
    to >= from ? value * power(to - from) : divideRounded(value, power(from - to))

const format =
  (value: bigint, precision: number, scale: number): string => {
    const magnitude = value < 0n ? -value : value
    if (magnitude.toString().length > precision) {
      throw new MssqlError('Arithmetic overflow error converting numeric to data type numeric.',
        8115, 16, 1, { statementTerminating: true })
    }
    const digits = magnitude.toString().padStart(scale + 1, '0')
    const whole = digits.slice(0, digits.length - scale)
    const fraction = scale === 0 ? '' : `.${digits.slice(-scale)}`
    return `${value < 0n && magnitude !== 0n ? '-' : ''}${whole}${fraction}`
  }

/** Exact DECIMAL/NUMERIC cast with SQL Server half-away-from-zero rounding. */
export const cast =
  (value: string | number | bigint | null, precision: number, scale: number, try_: boolean): string | null => {
    if (value === null) {
      return null
    }
    try {
      return format(signed(value, scale), precision, scale)
    } catch (error) {
      if (try_) {
        return null
      }
      if (error instanceof MssqlError) {
        throw error
      }
      throw new MssqlError(`Error converting data type to decimal: ${String(error)}`,
        8114, 16, 1, { statementTerminating: true })
    }
  }

/** Exact binary decimal operation returning a fixed-scale canonical string. */
export const arithmetic =
  (
    operator: string,
    left: string | number | bigint | null,
    right: string | number | bigint | null,
    leftScale: number,
    rightScale: number,
    precision: number,
    scale: number
  ): string | null => {
    if (left === null || right === null) {
      return null
    }
    const a = signed(left, leftScale)
    const b = signed(right, rightScale)
    if ((operator === '/' || operator === '%') && b === 0n) {
      throw new MssqlError('Divide by zero error encountered.',
        8134, 16, 1, { statementTerminating: true })
    }
    let result: bigint
    switch (operator) {
      case '+':
      case '-': {
        const common = Math.max(leftScale, rightScale)
        const left_ = rescale(a, leftScale, common)
        const right_ = rescale(b, rightScale, common)
        result = rescale(operator === '+' ? left_ + right_ : left_ - right_, common, scale)
        break
      }
      case '*':
        result = rescale(a * b, leftScale + rightScale, scale)
        break
      case '/': {
        const shift = rightScale + scale - leftScale
        result = shift >= 0 ? divideRounded(a * power(shift), b) :
          divideRounded(a, b * power(-shift))
        break
      }
      case '%': {
        const common = Math.max(leftScale, rightScale)
        result = rescale(
          rescale(a, leftScale, common) % rescale(b, rightScale, common), common, scale)
        break
      }
      default:
        throw new MssqlError(`Unsupported decimal operator ${operator}.`, 8114, 16)
    }
    return format(result, precision, scale)
  }
