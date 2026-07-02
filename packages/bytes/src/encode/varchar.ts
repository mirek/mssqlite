import concat from './concat.ts'
import ucs2 from './ucs2.ts'
import { uint16, uint8 } from './numbers.ts'

/** @returns B_VARCHAR bytes — UCS-2 string with an 8-bit character-count prefix. */
export const bVarchar =
  (value: string): Uint8Array =>
    concat(uint8(value.length), ucs2(value))

/** @returns US_VARCHAR bytes — UCS-2 string with a 16-bit character-count prefix. */
export const usVarchar =
  (value: string): Uint8Array =>
    concat(uint16(value.length), ucs2(value))
