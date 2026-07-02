import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder matching each provided decoder in sequence, producing a tuple of values. */
export function seq<T extends Read.t[]>(
  ...reads: T
): Read.t<{ [K in keyof T]: Read.Value<T[K]> }> {
  return function (originalCursor) {
    const values: unknown[] = []
    let cursor = originalCursor
    for (const read of reads) {
      const result = read(cursor)
      if (Result.failed(result)) {
        return Result.fail(originalCursor, `Failed sequence. ${result.reason}`)
      }
      values.push(result.value)
      cursor = result.cursor
    }
    return Result.ok(cursor, values) as Result.Ok<{ [K in keyof T]: Read.Value<T[K]> }>
  }
}

export default seq
