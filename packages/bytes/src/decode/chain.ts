import * as Result from '../result.ts'
import type * as Read from '../read.ts'

/** @returns decoder running `read`, then the decoder produced by `f` from its value. */
export const chain =
  <A, B>(read: Read.t<A>, f: (value: A) => Read.t<B>): Read.t<B> =>
    cursor => {
      const result = read(cursor)
      return Result.failed(result) ?
        result :
        f(result.value)(result.cursor)
    }

export default chain
