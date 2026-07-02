import * as Token from './token.ts'

const wordStart = /[a-z_#\u0080-\uffff]/i
const wordPart = /[\w$#\u0080-\uffff]/
const digit = /\d/

/** Error thrown on unterminated or invalid lexical elements. */
export class LexError extends Error {
  readonly offset: number
  constructor(message: string, offset: number) {
    super(`${message} at offset ${offset}.`)
    this.name = 'LexError'
    this.offset = offset
  }
}

const punctuation = [
  '>=', '<=', '<>', '!=', '!<', '!>', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '::',
  '(', ')', ',', '.', ';', '=', '<', '>', '+', '-', '*', '/', '%', '&', '^', '|', '~'
] as const

/**
 * @returns lexical tokens of T-SQL source — whitespace and comments skipped,
 * strings/quoted identifiers unescaped.
 * @throws LexError on unterminated strings, identifiers or comments.
 */
export const lex =
  (source: string): Token.t[] => {
    const tokens: Token.t[] = []
    let offset = 0
    scan: while (offset < source.length) {
      const char = source[offset] ?? ''
      // Whitespace.
      if (/\s/.test(char)) {
        offset++
        continue
      }
      // Line comment.
      if (char === '-' && source[offset + 1] === '-') {
        const end = source.indexOf('\n', offset)
        offset = end === -1 ? source.length : end + 1
        continue
      }
      // Block comment (nested per T-SQL).
      if (char === '/' && source[offset + 1] === '*') {
        let depth = 1
        let at = offset + 2
        while (depth > 0) {
          if (at >= source.length) {
            throw new LexError('Unterminated comment', offset)
          }
          if (source[at] === '/' && source[at + 1] === '*') {
            depth++
            at += 2
          } else if (source[at] === '*' && source[at + 1] === '/') {
            depth--
            at += 2
          } else {
            at++
          }
        }
        offset = at
        continue
      }
      // String literal, optionally national (N'...').
      if (char === '\'' || ((char === 'N' || char === 'n') && source[offset + 1] === '\'')) {
        const national = char !== '\''
        const start = offset
        let at = offset + (national ? 2 : 1)
        let value = ''
        for (;;) {
          if (at >= source.length) {
            throw new LexError('Unterminated string', start)
          }
          if (source[at] === '\'') {
            if (source[at + 1] === '\'') {
              value += '\''
              at += 2
            } else {
              at++
              break
            }
          } else {
            value += source[at]
            at++
          }
        }
        tokens.push({ kind: 'string', value, offset: start, national })
        offset = at
        continue
      }
      // Bracketed identifier.
      if (char === '[') {
        const start = offset
        let at = offset + 1
        let value = ''
        for (;;) {
          if (at >= source.length) {
            throw new LexError('Unterminated identifier', start)
          }
          if (source[at] === ']') {
            if (source[at + 1] === ']') {
              value += ']'
              at += 2
            } else {
              at++
              break
            }
          } else {
            value += source[at]
            at++
          }
        }
        tokens.push(Token.of('quoted', value, start))
        offset = at
        continue
      }
      // Double-quoted identifier.
      if (char === '"') {
        const start = offset
        let at = offset + 1
        let value = ''
        for (;;) {
          if (at >= source.length) {
            throw new LexError('Unterminated identifier', start)
          }
          if (source[at] === '"') {
            if (source[at + 1] === '"') {
              value += '"'
              at += 2
            } else {
              at++
              break
            }
          } else {
            value += source[at]
            at++
          }
        }
        tokens.push(Token.of('quoted', value, start))
        offset = at
        continue
      }
      // Variable (@name) or global variable (@@name).
      if (char === '@') {
        const start = offset
        let at = offset + 1
        if (source[at] === '@') {
          at++
        }
        while (at < source.length && wordPart.test(source[at] ?? '')) {
          at++
        }
        tokens.push(Token.of('variable', source.slice(start, at), start))
        offset = at
        continue
      }
      // Binary literal (0x...) or number.
      if (digit.test(char) || (char === '.' && digit.test(source[offset + 1] ?? ''))) {
        const start = offset
        if (char === '0' && (source[offset + 1] === 'x' || source[offset + 1] === 'X')) {
          let at = offset + 2
          while (at < source.length && /[\da-f]/i.test(source[at] ?? '')) {
            at++
          }
          tokens.push(Token.of('binary', source.slice(start, at), start))
          offset = at
          continue
        }
        let at = offset
        while (at < source.length && digit.test(source[at] ?? '')) {
          at++
        }
        if (source[at] === '.') {
          at++
          while (at < source.length && digit.test(source[at] ?? '')) {
            at++
          }
        }
        if (source[at] === 'e' || source[at] === 'E') {
          let exponent = at + 1
          if (source[exponent] === '+' || source[exponent] === '-') {
            exponent++
          }
          if (digit.test(source[exponent] ?? '')) {
            at = exponent
            while (at < source.length && digit.test(source[at] ?? '')) {
              at++
            }
          }
        }
        tokens.push(Token.of('number', source.slice(start, at), start))
        offset = at
        continue
      }
      // Word — identifier or keyword.
      if (wordStart.test(char)) {
        const start = offset
        let at = offset + 1
        while (at < source.length && wordPart.test(source[at] ?? '')) {
          at++
        }
        tokens.push(Token.of('word', source.slice(start, at), start))
        offset = at
        continue
      }
      // Punctuation and operators, longest match first.
      for (const symbol of punctuation) {
        if (source.startsWith(symbol, offset)) {
          tokens.push(Token.of('punct', symbol, offset))
          offset += symbol.length
          continue scan
        }
      }
      throw new LexError(`Unexpected character ${JSON.stringify(char)}`, offset)
    }
    return tokens
  }

export default lex
