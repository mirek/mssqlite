import { expect, test } from 'vitest'
import lex, { LexError } from './lex.ts'

const kinds =
  (sql: string): string[] =>
    lex(sql).map(token => `${token.kind}:${token.value}`)

test('words, numbers and punctuation', () => {
  expect(kinds('SELECT 1 + 2.5, x FROM t;')).toEqual([
    'word:SELECT', 'number:1', 'punct:+', 'number:2.5', 'punct:,',
    'word:x', 'word:FROM', 'word:t', 'punct:;'
  ])
})

test('strings unescape quotes', () => {
  expect(kinds('SELECT \'it\'\'s\'')).toEqual([ 'word:SELECT', 'string:it\'s' ])
  const national = lex('SELECT N\'ü\'')
  expect(national[1]).toMatchObject({ kind: 'string', value: 'ü', national: true })
})

test('bracketed and double-quoted identifiers', () => {
  expect(kinds('[My Table]."col""x"')).toEqual([ 'quoted:My Table', 'punct:.', 'quoted:col"x' ])
  expect(kinds('[a]]b]')).toEqual([ 'quoted:a]b' ])
})

test('variables', () => {
  expect(kinds('@x @@ROWCOUNT')).toEqual([ 'variable:@x', 'variable:@@ROWCOUNT' ])
})

test('comments are skipped', () => {
  expect(kinds('SELECT 1 -- trailing\n+ 2')).toEqual([ 'word:SELECT', 'number:1', 'punct:+', 'number:2' ])
  expect(kinds('SELECT /* nested /* deep */ done */ 1')).toEqual([ 'word:SELECT', 'number:1' ])
})

test('numbers with exponents and hex', () => {
  expect(kinds('1e5 1.5E-3 .5 0xDEADbeef')).toEqual([
    'number:1e5', 'number:1.5E-3', 'number:.5', 'binary:0xDEADbeef'
  ])
})

test('multi-character operators', () => {
  expect(kinds('a >= b <> c != d !< e += 1')).toEqual([
    'word:a', 'punct:>=', 'word:b', 'punct:<>', 'word:c', 'punct:!=',
    'word:d', 'punct:!<', 'word:e', 'punct:+=', 'number:1'
  ])
})

test('dollar-prefixed pseudo-columns lex as words', () => {
  expect(kinds('OUTPUT $action, $ACTION')).toEqual([
    'word:OUTPUT', 'word:$action', 'punct:,', 'word:$ACTION'
  ])
  expect(() => lex('$')).toThrow(LexError)
})

test('offsets track source positions', () => {
  const tokens = lex('SELECT x')
  expect(tokens[0]?.offset).toBe(0)
  expect(tokens[1]?.offset).toBe(7)
})

test('unterminated tokens throw', () => {
  expect(() => lex('\'oops')).toThrow(LexError)
  expect(() => lex('[oops')).toThrow(LexError)
  expect(() => lex('/* oops')).toThrow(LexError)
})
