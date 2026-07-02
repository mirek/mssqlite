/** Lexical token kinds. */
export type Kind =
  | 'word'
  | 'quoted'
  | 'string'
  | 'number'
  | 'binary'
  | 'variable'
  | 'punct'

/** Lexical token. */
export type Token = {
  readonly kind: Kind,
  /** Token text — unescaped value for `quoted`/`string`, raw text otherwise. */
  readonly value: string,
  /** Byte offset into the source. */
  readonly offset: number,
  /** `true` for `N'...'` national character strings. */
  readonly national?: boolean
}

export type t =
  Token

/** @returns token of a kind at an offset. */
export const of =
  (kind: Kind, value: string, offset: number): Token =>
    ({ kind, value, offset })
