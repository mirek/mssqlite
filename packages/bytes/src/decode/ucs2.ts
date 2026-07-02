import * as Ucs2 from '../ucs2.ts'
import bytes from './bytes.ts'
import map from './map.ts'
import type * as Read from '../read.ts'

/** @returns decoder of a UCS-2 string spanning `byteLength` bytes. */
export const ucs2 =
  (byteLength: number): Read.t<string> =>
    map(bytes(byteLength), Ucs2.decode)

/** @returns decoder of a UCS-2 string of `charLength` characters (2 bytes each). */
export const ucs2Chars =
  (charLength: number): Read.t<string> =>
    ucs2(charLength * 2)

export default ucs2
