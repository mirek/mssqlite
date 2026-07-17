import { Buffer } from 'node:buffer'
import type { Scalar } from './types.ts'

/** Stable JSON-safe representation for values returned by tedious. */
export const scalar =
  (value: unknown): Scalar => {
    if (value === null || typeof value === 'boolean' ||
      typeof value === 'number' || typeof value === 'string') {
      return value
    }
    if (typeof value === 'bigint') {
      return { kind: 'bigint', value: value.toString() }
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { kind: 'binary', value: Buffer.from(value).toString('hex') }
    }
    if (value instanceof Date) {
      return { kind: 'date', value: value.toISOString() }
    }
    return String(value)
  }
