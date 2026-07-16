import lex from './lex.ts'
import * as ParserModule from './parse/parser.ts'
import * as Reader from './parse/reader.ts'
import { batch, statement } from './parse/statement.ts'
import { expression } from './parse/expression.ts'
import type * as Ast from './ast.ts'

export { ParseError } from './parse/parser.ts'

// CREATE PROCEDURE/FUNCTION must be alone in its batch (MSSQL rule), so the
// whole batch source is the module definition stored in sys.sql_modules.
const withDefinition =
  (statement_: Ast.Statement, sql: string): Ast.Statement =>
    statement_.kind === 'createProcedure' || statement_.kind === 'createFunction' ?
      { ...statement_, definition: sql.trim() } :
      statement_

/**
 * @returns statements of a T-SQL batch.
 * @throws LexError | ParseError on invalid input.
 */
export const parse =
  (sql: string): Ast.Statement[] =>
    ParserModule.run(batch, Reader.of(lex(sql)))
      .map(statement_ => withDefinition(statement_, sql))

/**
 * @returns single parsed statement.
 * @throws LexError | ParseError on invalid input.
 */
export const parseStatement =
  (sql: string): Ast.Statement =>
    withDefinition(ParserModule.run(statement, Reader.of(lex(sql))), sql)

/**
 * @returns parsed expression.
 * @throws LexError | ParseError on invalid input.
 */
export const parseExpression =
  (sql: string): Ast.Expression =>
    ParserModule.run(expression, Reader.of(lex(sql)))

export default parse
