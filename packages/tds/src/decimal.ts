import { Encode } from '@mssqlite/bytes'

/** @returns wire byte length (including sign byte) for a decimal precision. */
export const length =
  (precision: number): number =>
    precision <= 9 ?
      5 :
      precision <= 19 ?
        9 :
        precision <= 28 ?
          13 :
          17

/** @returns scaled magnitude and sign of a decimal string like `-123.45` at given `scale`. */
export const parse =
  (value: string | number | bigint, scale: number): { negative: boolean, magnitude: bigint } => {
    const text = typeof value === 'string' ? value.trim() : value.toString()
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text)
    if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
      throw new Error(`Invalid decimal value ${JSON.stringify(value)}.`)
    }
    const [ , sign, whole = '', fraction = '', exponent ] = match
    const shift = Number(exponent ?? 0) + scale
    let digits = whole + fraction
    let point = whole.length + shift
    if (point < 0) {
      digits = '0'.repeat(-point) + digits
      point = 0
    }
    digits = digits.padEnd(point, '0')
    const integral = digits.slice(0, point) || '0'
    const rounder = (digits[point] ?? '0') >= '5' ? 1n : 0n
    return {
      negative: sign === '-',
      magnitude: BigInt(integral) + rounder
    }
  }

/** @returns decimal wire bytes — sign byte (1 positive, 0 negative) and little-endian magnitude. */
export const encode =
  (value: string | number | bigint, precision: number, scale: number): Uint8Array => {
    const { negative, magnitude } = parse(value, scale)
    const size = length(precision) - 1
    const bytes = new Uint8Array(1 + size)
    bytes[0] = negative ? 0 : 1
    let rest = magnitude
    for (let i = 0; i < size; i++) {
      bytes[1 + i] = Number(rest & 0xffn)
      rest >>= 8n
    }
    return Encode.concat(bytes)
  }

/** @returns decimal string from sign and little-endian magnitude wire bytes. */
export const decode =
  (bytes: Uint8Array, scale: number): string => {
    const negative = bytes[0] === 0
    let magnitude = 0n
    for (let i = bytes.length - 1; i >= 1; i--) {
      magnitude = (magnitude << 8n) | BigInt(bytes[i] ?? 0)
    }
    const digits = magnitude.toString().padStart(scale + 1, '0')
    const whole = digits.slice(0, digits.length - scale)
    const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`
    return `${negative && magnitude !== 0n ? '-' : ''}${whole}${fraction}`
  }
