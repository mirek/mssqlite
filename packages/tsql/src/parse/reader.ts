import type * as Token from '../token.ts'

/** Immutable read position over a token list. */
export type Reader = {
  readonly tokens: readonly Token.t[],
  readonly offset: number
}

export type t =
  Reader

/** @returns reader over tokens at optional offset (defaults to 0). */
export const of =
  (tokens: readonly Token.t[], offset = 0): Reader =>
    ({ tokens, offset })

/** @returns reader advanced by `advance` tokens. */
export const advanced =
  (reader: Reader, advance = 1): Reader =>
    ({ tokens: reader.tokens, offset: reader.offset + advance })

/** @returns token at `offset` from current position, `undefined` if out of bounds. */
export const peek =
  (reader: Reader, offset = 0): Token.t | undefined =>
    reader.tokens[reader.offset + offset]

/** @returns `true` if all tokens have been consumed. */
export const end =
  (reader: Reader): boolean =>
    reader.offset >= reader.tokens.length
