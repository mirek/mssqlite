import * as C from './combinators.ts'
import * as Reader from './reader.ts'
import * as Result from './result.ts'
import typeName from './type-name.ts'
import { alterTable, createIndex, createTable, createView, drop, dropIndex } from './ddl.ts'
import { delete_, insert, truncate, update } from './dml.ts'
import { expression } from './expression.ts'
import { select } from './select.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const statementRef: Parser.t<Ast.Statement> =
  reader => statement(reader)

/** DECLARE statement parser. */
const declare: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('declare'),
      C.sepBy1(
        C.map(
          C.seq(
            C.variable,
            C.maybe(C.keyword('as')),
            typeName,
            C.maybe(C.map(C.seq(C.punct('='), expression), ([ , value ]) => value))
          ),
          ([ name, , type, initial ]) => ({
            name,
            type,
            ...initial === undefined ? {} : { initial }
          })
        ),
        C.punct(',')
      )
    ),
    ([ , declarations ]) => ({ kind: 'declare' as const, declarations })
  )

const onOff: Parser.t<string> =
  C.first(C.keyword('on'), C.keyword('off'))

/** SET statement parser — variable assignment or session options. */
const set: Parser.t<Ast.Statement> =
  C.chain(C.keyword('set'), () =>
    C.first<Parser.t<Ast.Statement>[]>(
      C.map(
        C.seq(
          C.variable,
          C.first(...[ '=', '+=', '-=', '*=', '/=', '%=' ].map(C.punct)),
          expression
        ),
        ([ name, operator, value ]) => ({ kind: 'setVariable' as const, name, operator, value })
      ),
      // SET TRANSACTION ISOLATION LEVEL <level>.
      C.map(
        C.seq(
          C.keyword('transaction'), C.keyword('isolation'), C.keyword('level'),
          C.first(
            C.map(C.seq(C.keyword('read'), C.keyword('uncommitted')), () => 'read uncommitted'),
            C.map(C.seq(C.keyword('read'), C.keyword('committed')), () => 'read committed'),
            C.map(C.seq(C.keyword('repeatable'), C.keyword('read')), () => 'repeatable read'),
            C.keyword('serializable'),
            C.keyword('snapshot')
          )
        ),
        ([ , , , level ]) => ({
          kind: 'setOption' as const,
          options: [ 'transaction isolation level' ],
          value: level
        })
      ),
      // SET IDENTITY_INSERT table ON|OFF.
      C.map(
        C.seq(C.keyword('identity_insert'), C.qualifiedName, onOff),
        ([ , table, value ]) => ({
          kind: 'setOption' as const,
          options: [ `identity_insert ${table.join('.').toLowerCase()}` ],
          value
        })
      ),
      // SET option [, option ...] ON|OFF and other one-word settings.
      C.map(
        C.seq(C.sepBy1(C.anyIdentifier, C.punct(',')), C.first(onOff, C.anyIdentifier, C.map(expression, () => 'expression'))),
        ([ options, value ]) => ({
          kind: 'setOption' as const,
          options: options.map(option => option.toLowerCase()),
          value: value.toLowerCase()
        })
      )
    ))

/** BEGIN ... END block or BEGIN TRAN[SACTION]. */
const beginBlockOrTransaction: Parser.t<Ast.Statement> =
  reader => {
    const begin = C.keyword('begin')(reader)
    if (Result.failed(begin)) {
      return begin
    }
    const transaction = C.first(C.keyword('transaction'), C.keyword('tran'))(begin.reader)
    if (!Result.failed(transaction)) {
      const name = C.maybe(C.first(C.identifier, C.variable))(transaction.reader)
      if (Result.failed(name)) {
        return name
      }
      return Result.ok(name.reader, {
        kind: 'beginTransaction',
        ...name.value === undefined ? {} : { name: name.value }
      })
    }
    // BEGIN ... END block.
    const statements: Ast.Statement[] = []
    let current = begin.reader
    for (;;) {
      const end = C.keyword('end')(current)
      if (!Result.failed(end)) {
        return Result.ok(end.reader, { kind: 'block', statements })
      }
      const semicolon = C.punct(';')(current)
      if (!Result.failed(semicolon)) {
        current = semicolon.reader
        continue
      }
      const inner = statementRef(current)
      if (Result.failed(inner)) {
        return inner
      }
      statements.push(inner.value)
      current = inner.reader
    }
  }

const transaction: Parser.t<Ast.Statement> =
  C.first<Parser.t<Ast.Statement>[]>(
    C.map(
      C.seq(
        C.keyword('commit'),
        C.maybe(C.first(C.keyword('transaction'), C.keyword('tran'), C.keyword('work'))),
        C.maybe(C.first(C.identifier, C.variable))
      ),
      ([ , , name ]) => ({
        kind: 'commitTransaction' as const,
        ...name === undefined ? {} : { name }
      })
    ),
    C.map(
      C.seq(
        C.keyword('rollback'),
        C.maybe(C.first(C.keyword('transaction'), C.keyword('tran'), C.keyword('work'))),
        C.maybe(C.first(C.identifier, C.variable))
      ),
      ([ , , name ]) => ({
        kind: 'rollbackTransaction' as const,
        ...name === undefined ? {} : { name }
      })
    ),
    C.map(
      C.seq(
        C.keyword('save'),
        C.first(C.keyword('transaction'), C.keyword('tran')),
        C.first(C.identifier, C.variable)
      ),
      ([ , , name ]) => ({ kind: 'saveTransaction' as const, name })
    )
  )

const ifStatement: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('if'),
      expression,
      C.maybe(C.punct(';')),
      statementRef,
      C.maybe(C.map(
        C.seq(C.maybe(C.punct(';')), C.keyword('else'), statementRef),
        ([ , , else_ ]) => else_
      ))
    ),
    ([ , condition, , then, else_ ]) => ({
      kind: 'if' as const,
      condition,
      then,
      ...else_ === undefined ? {} : { else_ }
    })
  )

const whileStatement: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('while'), expression, statementRef),
    ([ , condition, body ]) => ({ kind: 'while' as const, condition, body })
  )

const executeArgument: Parser.t<{ name?: string, value: Ast.Expression, output: boolean }> =
  C.map(
    C.seq(
      C.maybe(C.map(C.seq(C.variable, C.punct('=')), ([ name ]) => name)),
      expression,
      C.maybe(C.first(C.keyword('output'), C.keyword('out')))
    ),
    ([ name, value, output ]) => ({
      ...name === undefined ? {} : { name },
      value,
      output: output !== undefined
    })
  )

const execute: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.first(C.keyword('exec'), C.keyword('execute')),
      C.maybe(C.map(C.seq(C.variable, C.punct('=')), ([ result ]) => result)),
      C.qualifiedName,
      C.maybe(C.sepBy1(executeArgument, C.punct(',')))
    ),
    ([ , result, procedure, args ]) => ({
      kind: 'execute' as const,
      procedure,
      args: args ?? [],
      ...result === undefined ? {} : { result }
    })
  )

const use: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('use'), C.anyIdentifier),
    ([ , database ]) => ({ kind: 'use' as const, database })
  )

const print: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('print'), expression),
    ([ , expression_ ]) => ({ kind: 'print' as const, expression: expression_ })
  )

const returnStatement: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('return'), C.maybe(expression)),
    ([ , expression_ ]) => ({
      kind: 'return' as const,
      ...expression_ === undefined ? {} : { expression: expression_ }
    })
  )

const throwStatement: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('throw'),
      C.maybe(C.map(
        C.seq(expression, C.punct(','), expression, C.punct(','), expression),
        ([ number, , message, , state ]) => ({ number, message, state })
      ))
    ),
    ([ , args ]) =>
      args === undefined ?
        { kind: 'throw' as const } :
        { kind: 'throw' as const, number: args.number, message: args.message, state: args.state }
  )

/** Single statement parser. */
export const statement: Parser.t<Ast.Statement> =
  C.first<Parser.t<Ast.Statement>[]>(
    select,
    insert,
    update,
    delete_,
    createTable,
    createIndex,
    createView,
    alterTable,
    dropIndex,
    drop,
    truncate,
    declare,
    set,
    beginBlockOrTransaction,
    transaction,
    ifStatement,
    whileStatement,
    execute,
    use,
    print,
    returnStatement,
    throwStatement,
    C.map(C.keyword('break'), () => ({ kind: 'break' as const })),
    C.map(C.keyword('continue'), () => ({ kind: 'continue' as const }))
  )

/** Batch parser — statements separated by optional semicolons, consuming all input. */
export const batch: Parser.t<Ast.Statement[]> =
  reader => {
    const statements: Ast.Statement[] = []
    let current = reader
    for (;;) {
      while (!Result.failed(C.punct(';')(current))) {
        current = Reader.advanced(current)
      }
      if (Reader.end(current)) {
        return Result.ok(current, statements)
      }
      const result = statement(current)
      if (Result.failed(result)) {
        return result
      }
      statements.push(result.value)
      current = result.reader
    }
  }
