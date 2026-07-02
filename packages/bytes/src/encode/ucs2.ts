import * as Ucs2 from '../ucs2.ts'

/** @returns UCS-2 (UTF-16LE) bytes of provided string. */
export const ucs2 =
  (value: string): Uint8Array =>
    Ucs2.encode(value)

export default ucs2
