import * as Cursor from './cursor.ts'

/** Successful decode result. */
export type Ok<T = unknown> = {
  cursor: Cursor.t,
  value: T,
  reason?: undefined
}

/** Decode failure with a reason. */
export type Fail = {
  cursor: Cursor.t,
  value?: undefined,
  reason: string
}

/** Decode result of some type (default `unknown`). */
export type Result<T = unknown> =
  | Ok<T>
  | Fail

export type t<T = unknown> =
  Result<T>

/** @returns successful result with provided value and optional cursor advance. */
export const ok =
  <T>(cursor: Cursor.t, value: T, advance = 0): Ok<T> => ({
    cursor: advance === 0 ? cursor : Cursor.advanced(cursor, advance),
    value
  })

/** @returns failure result. */
export const fail =
  (cursor: Cursor.t, reason: string): Fail => ({
    cursor,
    reason
  })

/** @returns `true` if result is a failure, `false` otherwise. */
export const failed =
  (result: Result): result is Fail =>
    result.reason !== undefined
