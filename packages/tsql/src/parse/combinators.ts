import * as Reader from './reader.ts'
import * as Result from './result.ts'
import type * as Parser from './parser.ts'

/** @returns parser applying `f` to the value produced by `parser`. */
export const map =
  <A, B>(parser: Parser.t<A>, f: (value: A) => B): Parser.t<B> =>
    reader => {
      const result = parser(reader)
      return Result.failed(result) ?
        result :
        Result.ok(result.reader, f(result.value))
    }

/** @returns parser running `parser`, then the parser produced by `f` from its value. */
export const chain =
  <A, B>(parser: Parser.t<A>, f: (value: A) => Parser.t<B>): Parser.t<B> =>
    reader => {
      const result = parser(reader)
      return Result.failed(result) ?
        result :
        f(result.value)(result.reader)
    }

/** @returns parser matching each provided parser in sequence, producing a tuple of values. */
export function seq<T extends Parser.t[]>(
  ...parsers: T
): Parser.t<{ [K in keyof T]: Parser.Parsed<T[K]> }> {
  return function (originalReader) {
    const values: unknown[] = []
    let reader = originalReader
    for (const parser of parsers) {
      const result = parser(reader)
      if (Result.failed(result)) {
        return Result.fail(originalReader, result.reason)
      }
      values.push(result.value)
      reader = result.reader
    }
    return Result.ok(reader, values) as Result.Ok<{ [K in keyof T]: Parser.Parsed<T[K]> }>
  }
}

/** @returns parser producing the value of the first parser that matches. */
export function first<T extends Parser.t[]>(
  ...parsers: T
): Parser.t<Parser.Parsed<T[number]>> {
  return function (reader) {
    let farthest: Result.Fail | undefined
    for (const parser of parsers) {
      const result = parser(reader)
      if (!Result.failed(result)) {
        return result as Result.Ok<Parser.Parsed<T[number]>>
      }
      if (farthest === undefined || result.reader.offset > farthest.reader.offset) {
        farthest = result
      }
    }
    return farthest ?? Result.fail(reader, 'No alternatives.')
  }
}

/** @returns parser producing `undefined` instead of failing. */
export const maybe =
  <T>(parser: Parser.t<T>): Parser.t<T | undefined> =>
    reader => {
      const result = parser(reader)
      return Result.failed(result) ?
        Result.ok(reader, undefined) :
        result
    }

/** @returns parser matching zero or more occurrences. */
export const many0 =
  <T>(parser: Parser.t<T>): Parser.t<T[]> =>
    originalReader => {
      const values: T[] = []
      let reader = originalReader
      for (;;) {
        const result = parser(reader)
        if (Result.failed(result) || result.reader.offset === reader.offset) {
          return Result.ok(reader, values)
        }
        values.push(result.value)
        reader = result.reader
      }
    }

/** @returns parser matching one or more occurrences. */
export const many1 =
  <T>(parser: Parser.t<T>): Parser.t<T[]> =>
    chain(parser, head =>
      map(many0(parser), tail => [ head, ...tail ]))

/** @returns parser matching one or more `parser` separated by `separator`. */
export const sepBy1 =
  <T>(parser: Parser.t<T>, separator: Parser.t): Parser.t<T[]> =>
    chain(parser, head =>
      map(
        many0(map(seq(separator, parser), ([ , value ]) => value)),
        tail => [ head, ...tail ]
      ))

/** @returns parser deferring construction until first use — enables recursive grammars. */
export const lazy =
  <T>(make: () => Parser.t<T>): Parser.t<T> => {
    let parser: Parser.t<T> | undefined
    return reader =>
      (parser ??= make())(reader)
  }

/** @returns parser producing a constant value without consuming input. */
export const pure =
  <T>(value: T): Parser.t<T> =>
    reader =>
      Result.ok(reader, value)

/** @returns parser matching a `word` token equal to `word` (case-insensitive). */
export const keyword =
  (word: string): Parser.t<string> =>
    reader => {
      const token = Reader.peek(reader)
      return token?.kind === 'word' && token.value.toLowerCase() === word ?
        Result.ok(reader, word, 1) :
        Result.fail(reader, `Expected ${word.toUpperCase()}.`)
    }

/** @returns parser matching consecutive keywords, e.g. `keywords('group', 'by')`. */
export const keywords =
  (...words: string[]): Parser.t<string> =>
    map(seq(...words.map(keyword)), () => words.join(' '))

/** @returns parser matching a punctuation token equal to `symbol`. */
export const punct =
  (symbol: string): Parser.t<string> =>
    reader => {
      const token = Reader.peek(reader)
      return token?.kind === 'punct' && token.value === symbol ?
        Result.ok(reader, symbol, 1) :
        Result.fail(reader, `Expected ${JSON.stringify(symbol)}.`)
    }

/** @returns parser wrapping `parser` in parentheses. */
export const parens =
  <T>(parser: Parser.t<T>): Parser.t<T> =>
    map(seq(punct('('), parser, punct(')')), ([ , value ]) => value)

/** Words that cannot start an alias or bare identifier position. */
const reserved = new Set([
  'select', 'insert', 'update', 'delete', 'from', 'where', 'group', 'having', 'order',
  'union', 'except', 'intersect', 'join', 'inner', 'left', 'right', 'full', 'cross', 'on',
  'as', 'and', 'or', 'not', 'null', 'is', 'in', 'like', 'between', 'exists', 'case', 'when',
  'then', 'else', 'end', 'create', 'alter', 'drop', 'table', 'index', 'view', 'into',
  'values', 'set', 'declare', 'if', 'while', 'begin', 'commit', 'rollback', 'return',
  'exec', 'execute', 'use', 'print', 'truncate', 'top', 'distinct', 'option', 'by',
  'asc', 'desc', 'offset', 'fetch', 'pivot', 'unpivot', 'break', 'continue', 'throw',
  'goto', 'waitfor', 'merge', 'using', 'output', 'default', 'primary', 'foreign', 'references',
  'constraint', 'check', 'unique', 'identity'
])

/** @returns parser matching an identifier — quoted, or unreserved word. */
export const identifier: Parser.t<string> =
  reader => {
    const token = Reader.peek(reader)
    if (token === undefined) {
      return Result.fail(reader, 'Expected identifier.')
    }
    if (token.kind === 'quoted') {
      return Result.ok(reader, token.value, 1)
    }
    if (token.kind === 'word' && !reserved.has(token.value.toLowerCase())) {
      return Result.ok(reader, token.value, 1)
    }
    return Result.fail(reader, `Expected identifier, got ${JSON.stringify(token.value)}.`)
  }

/** @returns parser matching any word or quoted token as identifier (contexts with no ambiguity). */
export const anyIdentifier: Parser.t<string> =
  reader => {
    const token = Reader.peek(reader)
    return token !== undefined && (token.kind === 'word' || token.kind === 'quoted') ?
      Result.ok(reader, token.value, 1) :
      Result.fail(reader, 'Expected identifier.')
  }

/**
 * @returns parser matching a dotted qualified name like `db.schema.table` or `a..b`.
 * The head part must be unreserved (or quoted); later parts may be any word.
 */
export const qualifiedName: Parser.t<string[]> =
  reader => {
    const head = identifier(reader)
    if (Result.failed(head)) {
      return head
    }
    const parts = [ head.value ]
    let current = head.reader
    for (;;) {
      const dot = punct('.')(current)
      if (Result.failed(dot)) {
        break
      }
      const part = anyIdentifier(dot.reader)
      if (Result.failed(part)) {
        // Empty part as in `db..table` — MSSQL's default-schema shorthand.
        const next = punct('.')(dot.reader)
        if (Result.failed(next)) {
          break
        }
        parts.push('dbo')
        current = dot.reader
        continue
      }
      parts.push(part.value)
      current = part.reader
    }
    return Result.ok(current, parts)
  }

/** @returns parser matching a variable token like `@name` producing its full text. */
export const variable: Parser.t<string> =
  reader => {
    const token = Reader.peek(reader)
    return token?.kind === 'variable' ?
      Result.ok(reader, token.value, 1) :
      Result.fail(reader, 'Expected variable.')
  }
