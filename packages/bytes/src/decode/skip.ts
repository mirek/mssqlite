import * as Cursor from '../cursor.ts'
import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder skipping `length` bytes, producing `undefined`. */
export const skip =
  (length: number): Read.t<undefined> =>
    cursor =>
      Cursor.remaining(cursor) < length ?
        Result.fail(cursor, `Expected ${length} bytes to skip, got ${Cursor.remaining(cursor)}.`) :
        Result.ok(cursor, undefined, length)

export default skip
