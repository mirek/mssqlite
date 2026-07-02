import type * as Cursor from './cursor.ts'
import type * as Result from './result.ts'

/** Decoder taking a cursor and producing a result. */
export type Read<T = unknown> =
  (cursor: Cursor.t) =>
    Result.t<T>

export type t<T = unknown> =
  Read<T>

/** Value type produced by a decoder. */
export type Value<T> =
  T extends Read<infer R> ?
    R :
    never
