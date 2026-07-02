import * as Reader from './reader.ts'
import * as Result from './result.ts'

/** Parser over tokens producing a value. */
export type Parser<T = unknown> =
  (reader: Reader.t) =>
    Result.t<T>

export type t<T = unknown> =
  Parser<T>

/** Value type produced by a parser. */
export type Parsed<T> =
  T extends Parser<infer R> ?
    R :
    never

/** Parse error with source offset. */
export class ParseError extends Error {
  readonly offset: number
  constructor(message: string, offset: number) {
    super(message)
    this.name = 'ParseError'
    this.offset = offset
  }
}

/**
 * @returns parsed value asserting all tokens were consumed.
 * @throws ParseError if the parser fails or input remains.
 */
export const run =
  <T>(parser: Parser<T>, reader: Reader.t): T => {
    const result = parser(reader)
    if (Result.failed(result)) {
      const at = Reader.peek(result.reader)
      throw new ParseError(result.reason, at?.offset ?? -1)
    }
    if (!Reader.end(result.reader)) {
      const at = Reader.peek(result.reader)
      throw new ParseError(
        `Unexpected ${JSON.stringify(at?.value ?? 'end')}.`,
        at?.offset ?? -1
      )
    }
    return result.value
  }
