import lex from './lex.ts'
import * as ParserModule from './parse/parser.ts'
import * as Reader from './parse/reader.ts'
import { batch, statement } from './parse/statement.ts'
import { expression } from './parse/expression.ts'
import type * as Ast from './ast.ts'

export { ParseError } from './parse/parser.ts'

/**
 * @returns statements of a T-SQL batch.
 * @throws LexError | ParseError on invalid input.
 */
export const parse =
  (sql: string): Ast.Statement[] =>
    ParserModule.run(batch, Reader.of(lex(sql)))

/**
 * @returns single parsed statement.
 * @throws LexError | ParseError on invalid input.
 */
export const parseStatement =
  (sql: string): Ast.Statement =>
    ParserModule.run(statement, Reader.of(lex(sql)))

/**
 * @returns parsed expression.
 * @throws LexError | ParseError on invalid input.
 */
export const parseExpression =
  (sql: string): Ast.Expression =>
    ParserModule.run(expression, Reader.of(lex(sql)))

export default parse
