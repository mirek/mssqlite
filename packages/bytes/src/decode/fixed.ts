import * as Cursor from '../cursor.ts'
import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder of a fixed `size` value extracted from the data view by `get`. */
export const fixed =
  <T>(size: number, get: (view: DataView, offset: number) => T): Read.t<T> =>
    cursor =>
      Cursor.remaining(cursor) < size ?
        Result.fail(cursor, `Expected ${size} bytes, got ${Cursor.remaining(cursor)}.`) :
        Result.ok(cursor, get(cursor.view, cursor.offset), size)

export default fixed
