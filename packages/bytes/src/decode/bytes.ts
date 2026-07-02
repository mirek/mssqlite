import * as Cursor from '../cursor.ts'
import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder of `length` raw bytes, sharing the underlying buffer. */
export const bytes =
  (length: number): Read.t<Uint8Array> =>
    cursor =>
      Cursor.remaining(cursor) < length ?
        Result.fail(cursor, `Expected ${length} bytes, got ${Cursor.remaining(cursor)}.`) :
        Result.ok(cursor, Cursor.slice(cursor, 0, length), length)

export default bytes
