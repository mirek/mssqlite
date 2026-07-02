import concat from './concat.ts'
import { uint16, uint32, uint8 } from './numbers.ts'

/** @returns B_VARBYTE bytes — raw bytes with an 8-bit byte-count prefix. */
export const bVarbyte =
  (value: Uint8Array): Uint8Array =>
    concat(uint8(value.byteLength), value)

/** @returns US_VARBYTE bytes — raw bytes with a 16-bit byte-count prefix. */
export const usVarbyte =
  (value: Uint8Array): Uint8Array =>
    concat(uint16(value.byteLength), value)

/** @returns L_VARBYTE bytes — raw bytes with a 32-bit byte-count prefix. */
export const lVarbyte =
  (value: Uint8Array): Uint8Array =>
    concat(uint32(value.byteLength), value)
