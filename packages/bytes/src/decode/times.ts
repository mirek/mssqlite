import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder running `read` exactly `count` times, producing an array of values. */
export const times =
  <T>(count: number, read: Read.t<T>): Read.t<T[]> =>
    originalCursor => {
      const values: T[] = []
      let cursor = originalCursor
      for (let i = 0; i < count; i++) {
        const result = read(cursor)
        if (Result.failed(result)) {
          return Result.fail(originalCursor, `Failed at ${i} of ${count}. ${result.reason}`)
        }
        values.push(result.value)
        cursor = result.cursor
      }
      return Result.ok(cursor, values)
    }

export default times
