import bytes from './bytes.ts'
import chain from './chain.ts'
import { uint16, uint32, uint8 } from './numbers.ts'
import type * as Read from '../read.ts'

/** B_VARBYTE decoder — raw bytes with an 8-bit byte-count prefix. */
export const bVarbyte: Read.t<Uint8Array> =
  chain(uint8, bytes)

/** US_VARBYTE decoder — raw bytes with a 16-bit byte-count prefix. */
export const usVarbyte: Read.t<Uint8Array> =
  chain(uint16, bytes)

/** L_VARBYTE decoder — raw bytes with a 32-bit byte-count prefix. */
export const lVarbyte: Read.t<Uint8Array> =
  chain(uint32, bytes)
