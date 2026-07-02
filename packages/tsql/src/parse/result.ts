import * as Reader from './reader.ts'

/** Successful parse result. */
export type Ok<T = unknown> = {
  reader: Reader.t,
  value: T,
  reason?: undefined
}

/** Parse failure with a reason. */
export type Fail = {
  reader: Reader.t,
  value?: undefined,
  reason: string
}

/** Parse result of some type (default `unknown`). */
export type Result<T = unknown> =
  | Ok<T>
  | Fail

export type t<T = unknown> =
  Result<T>

/** @returns successful result with provided value and optional reader advance. */
export const ok =
  <T>(reader: Reader.t, value: T, advance = 0): Ok<T> => ({
    reader: advance === 0 ? reader : Reader.advanced(reader, advance),
    value
  })

/** @returns failure result. */
export const fail =
  (reader: Reader.t, reason: string): Fail => ({
    reader,
    reason
  })

/** @returns `true` if result is a failure, `false` otherwise. */
export const failed =
  (result: Result): result is Fail =>
    result.reason !== undefined
