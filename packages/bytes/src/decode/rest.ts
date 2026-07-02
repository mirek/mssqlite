import * as Cursor from '../cursor.ts'
import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** Decoder producing all remaining bytes, sharing the underlying buffer. */
export const rest: Read.t<Uint8Array> =
  cursor => {
    const length = Cursor.remaining(cursor)
    return Result.ok(cursor, Cursor.slice(cursor, 0, length), length)
  }

export default rest
