import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder applying `f` to the value produced by `read`. */
export const map =
  <A, B>(read: Read.t<A>, f: (value: A) => B): Read.t<B> =>
    cursor => {
      const result = read(cursor)
      return Result.failed(result) ?
        result :
        Result.ok(result.cursor, f(result.value))
    }

export default map
