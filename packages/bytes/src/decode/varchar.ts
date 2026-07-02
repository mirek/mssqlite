import chain from './chain.ts'
import { ucs2Chars } from './ucs2.ts'
import { uint16, uint8 } from './numbers.ts'
import type * as Read from '../read.ts'

/** B_VARCHAR decoder — UCS-2 string with an 8-bit character-count prefix. */
export const bVarchar: Read.t<string> =
  chain(uint8, ucs2Chars)

/** US_VARCHAR decoder — UCS-2 string with a 16-bit character-count prefix. */
export const usVarchar: Read.t<string> =
  chain(uint16, ucs2Chars)
