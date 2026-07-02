import * as Cursor from '../cursor.ts'
import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/**
 * @returns decoder of a little-endian unsigned integer spanning `byteLength` bytes (1-6).
 * Values stay within `Number.MAX_SAFE_INTEGER` for up to 6 bytes.
 */
export const uintLe =
  (byteLength: number): Read.t<number> =>
    cursor => {
      if (Cursor.remaining(cursor) < byteLength) {
        return Result.fail(cursor, `Expected ${byteLength} bytes, got ${Cursor.remaining(cursor)}.`)
      }
      let value = 0
      for (let i = byteLength - 1; i >= 0; i--) {
        value = (value * 0x100) + (cursor.bytes[cursor.offset + i] ?? 0)
      }
      return Result.ok(cursor, value, byteLength)
    }

export default uintLe
