import * as C from './combinators.ts'
import * as Reader from './reader.ts'
import * as Result from './result.ts'
import typeName from './type-name.ts'
import {
  alterTable,
  alterDatabase,
  columnDefinition,
  createIndex,
  createDatabase,
  createTable,
  createView,
  drop,
  dropDatabase,
  dropIndex,
  tableConstraint
} from './ddl.ts'
import { delete_, insert, merge, truncate, update } from './dml.ts'
import { expression } from './expression.ts'
import { select } from './select.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const statementRef: Parser.t<Ast.Statement> =
  reader => statement(reader)

const scalarDeclaration: Parser.t<Ast.Declaration & { kind: 'scalar' }> =
  C.map(
    C.seq(
      C.variable,
      C.maybe(C.keyword('as')),
      typeName,
      C.maybe(C.map(C.seq(C.punct('='), expression), ([ , value ]) => value))
    ),
    ([ name, , type, initial ]) => ({
      kind: 'scalar' as const,
      name,
      type,
      ...initial === undefined ? {} : { initial }
    })
  )

const tableDeclaration: Parser.t<Ast.Declaration & { kind: 'table' }> =
  C.map(
    C.seq(
      C.variable,
      C.maybe(C.keyword('as')),
      C.keyword('table'),
      C.parens(C.sepBy1(
        C.first<(Parser.t<Ast.TableConstraint | Ast.ColumnDefinition>)[]>(
          tableConstraint,
        columnDefinition
        ),
        C.punct(',')
      ))
    ),
    ([ name, , , members ]) => ({
      kind: 'table' as const,
      name,
      columns: members.filter((member): member is Ast.ColumnDefinition => !('kind' in member)),
      constraints: members.filter((member): member is Ast.TableConstraint => 'kind' in member)
    })
  )

/** DECLARE statement parser. A table variable must be the only declaration. */
const declare: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('declare'),
      C.first(
        C.map(tableDeclaration, declaration => [ declaration ]),
        C.sepBy1(scalarDeclaration, C.punct(','))
      )
    ),
    ([ , declarations ]) => ({ kind: 'declare' as const, declarations })
  )

const cursorOption: Parser.t<string> =
  C.first(
    C.keyword('local'), C.keyword('global'), C.keyword('forward_only'),
    C.keyword('scroll'), C.keyword('static'), C.keyword('keyset'),
    C.keyword('dynamic'), C.keyword('fast_forward'), C.keyword('read_only'),
    C.keyword('scroll_locks'), C.keyword('optimistic'), C.keyword('type_warning'),
    C.keyword('insensitive')
  )

const declareCursor: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('declare'),
      C.anyIdentifier,
      C.many0(cursorOption),
      C.keyword('cursor'),
      C.many0(cursorOption),
      C.keyword('for'),
      select,
      C.maybe(C.map(
        C.seq(
          C.keyword('for'), C.keyword('update'),
          C.maybe(C.map(
            C.seq(C.keyword('of'), C.sepBy1(C.anyIdentifier, C.punct(','))),
            ([ , columns ]) => columns
          ))
        ),
        ([ , , columns ]) => columns ?? []
      ))
    ),
    ([ , name, before, , after, , select_, updateColumns ]) => {
      const options = [ ...before, ...after ]
      const scope = options.includes('global') ? 'global' as const :
        options.includes('local') ? 'local' as const :
          'global' as const
      return {
        kind: 'declareCursor' as const,
        name,
        scope,
        options: options.filter(option => option !== 'local' && option !== 'global'),
        select: select_,
        ...updateColumns === undefined ? {} : { updateColumns }
      }
    }
  )

const cursorNameStatement =
  (keyword: 'open' | 'close' | 'deallocate', kind: 'openCursor' | 'closeCursor' | 'deallocateCursor'): Parser.t<Ast.Statement> =>
    C.map(
      C.seq(
        C.keyword(keyword), C.maybe(C.keyword('cursor')),
        C.maybe(C.keyword('global')), C.anyIdentifier
      ),
      ([ , , , name ]) => ({ kind, name })
    ) as Parser.t<Ast.Statement>

const fetchOrientation: Parser.t<Ast.FetchOrientation> =
  C.first(
    ...([ 'next', 'prior', 'first', 'last' ] as const).map(kind =>
      C.map(C.keyword(kind), () => ({ kind }))),
    C.map(
      C.seq(C.keyword('absolute'), expression),
      ([ , offset ]) => ({ kind: 'absolute' as const, offset })
    ),
    C.map(
      C.seq(C.keyword('relative'), expression),
      ([ , offset ]) => ({ kind: 'relative' as const, offset })
    )
  )

const fetchCursor: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('fetch'),
      C.maybe(fetchOrientation),
      C.maybe(C.keyword('from')),
      C.maybe(C.keyword('global')),
      C.anyIdentifier,
      C.maybe(C.map(
        C.seq(C.keyword('into'), C.sepBy1(C.variable, C.punct(','))),
        ([ , variables ]) => variables
      ))
    ),
    ([ , orientation, , , name, into ]) => ({
      kind: 'fetchCursor' as const,
      name,
      orientation: orientation ?? { kind: 'next' },
      into: into ?? []
    })
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
          kind: 'setIdentityInsert' as const,
          table,
          enabled: value === 'on'
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

/** Statements up to the two-word terminator END TRY / END CATCH. */
const statementsUntilEnd =
  (terminator: 'try' | 'catch'): Parser.t<Ast.Statement[]> =>
    reader => {
      const statements: Ast.Statement[] = []
      let current = reader
      for (;;) {
        const end = C.seq(C.keyword('end'), C.keyword(terminator))(current)
        if (!Result.failed(end)) {
          return Result.ok(end.reader, statements)
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

/** BEGIN ... END block, BEGIN TRAN[SACTION], or BEGIN TRY ... BEGIN CATCH. */
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
    const try_ = C.keyword('try')(begin.reader)
    if (!Result.failed(try_)) {
      const tryBody = statementsUntilEnd('try')(try_.reader)
      if (Result.failed(tryBody)) {
        return tryBody
      }
      const beginCatch = C.seq(C.keyword('begin'), C.keyword('catch'))(tryBody.reader)
      if (Result.failed(beginCatch)) {
        return beginCatch
      }
      const catchBody = statementsUntilEnd('catch')(beginCatch.reader)
      if (Result.failed(catchBody)) {
        return catchBody
      }
      return Result.ok(catchBody.reader, {
        kind: 'tryCatch',
        try_: tryBody.value,
        catch_: catchBody.value
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

const raiserror: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('raiserror'),
      C.parens(C.sepBy1(expression, C.punct(','))),
      C.maybe(C.map(
        C.seq(C.keyword('with'), C.sepBy1(C.anyIdentifier, C.punct(','))),
        ([ , options ]) => options
      ))
    ),
    ([ , args, options ]) => ({
      kind: 'raiserror' as const,
      args,
      options: (options ?? []).map(option => option.toLowerCase())
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

const procedureKeyword: Parser.t<string> =
  C.first(C.keyword('procedure'), C.keyword('proc'))

const procedureParameter: Parser.t<Ast.ProcedureParameter> =
  C.map(
    C.seq(
      C.variable,
      C.maybe(C.keyword('as')),
      typeName,
      C.maybe(C.map(C.seq(C.punct('='), expression), ([ , value ]) => value)),
      C.maybe(C.first(C.keyword('output'), C.keyword('out'))),
      C.maybe(C.keyword('readonly'))
    ),
    ([ name, , type, default_, output ]) => ({
      name,
      type,
      ...default_ === undefined ? {} : { default_ },
      output: output !== undefined
    })
  )

const functionParameter: Parser.t<Ast.FunctionParameter> =
  C.map(
    C.seq(
      C.variable,
      C.maybe(C.keyword('as')),
      typeName,
      C.maybe(C.map(C.seq(C.punct('='), expression), ([ , value ]) => value))
    ),
    ([ name, , type, default_ ]) => ({
      name,
      type,
      ...default_ === undefined ? {} : { default_ }
    })
  )

const functionAction: Parser.t<'create' | 'alter' | 'createOrAlter'> =
  C.first(
    C.map(
      C.seq(C.keyword('create'), C.keyword('or'), C.keyword('alter'), C.keyword('function')),
      () => 'createOrAlter' as const
    ),
    C.map(C.seq(C.keyword('create'), C.keyword('function')), () => 'create' as const),
    C.map(C.seq(C.keyword('alter'), C.keyword('function')), () => 'alter' as const)
  )

const functionParameters: Parser.t<Ast.FunctionParameter[]> =
  C.parens(C.map(C.maybe(C.sepBy1(functionParameter, C.punct(','))), values => values ?? []))

const createFunction: Parser.t<Ast.Statement> =
  reader => {
    const head = C.seq(functionAction, C.qualifiedName, functionParameters, C.keyword('returns'))(reader)
    if (Result.failed(head)) {
      return head
    }
    const [ action, name, parameters ] = head.value
    const table = C.seq(
      C.keyword('table'),
      C.keyword('as'),
      C.keyword('return'),
      C.parens(select)
    )(head.reader)
    if (!Result.failed(table)) {
      return Result.ok(table.reader, {
        kind: 'createFunction',
        name,
        action,
        parameters,
        returns: { kind: 'table', select: table.value[3] },
        definition: ''
      })
    }
    const scalar = C.seq(typeName, C.keyword('as'), beginBlockOrTransaction)(head.reader)
    if (Result.failed(scalar)) {
      return scalar
    }
    const body = scalar.value[2]
    if (body.kind !== 'block') {
      return Result.fail(head.reader, 'Scalar function body must be BEGIN ... END.')
    }
    return Result.ok(scalar.reader, {
      kind: 'createFunction',
      name,
      action,
      parameters,
      returns: { kind: 'scalar', type: scalar.value[0], body: body.statements },
      definition: ''
    })
  }

/** Statements to the end of the batch — a procedure body owns the rest. */
const statementsUntilInputEnd: Parser.t<Ast.Statement[]> =
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
      const inner = statementRef(current)
      if (Result.failed(inner)) {
        return inner
      }
      statements.push(inner.value)
      current = inner.reader
    }
  }

const createProcedure: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.first(
        C.map(
          C.seq(C.keyword('create'), C.keyword('or'), C.keyword('alter'), procedureKeyword),
          () => 'createOrAlter' as const
        ),
        C.map(C.seq(C.keyword('create'), procedureKeyword), () => 'create' as const),
        C.map(C.seq(C.keyword('alter'), procedureKeyword), () => 'alter' as const)
      ),
      C.qualifiedName,
      C.maybe(C.first(
        C.parens(C.sepBy1(procedureParameter, C.punct(','))),
        C.sepBy1(procedureParameter, C.punct(','))
      )),
      C.keyword('as'),
      statementsUntilInputEnd
    ),
    ([ action, name, parameters, , body ]) => ({
      kind: 'createProcedure' as const,
      name,
      action,
      parameters: parameters ?? [],
      body,
      // Patched with the batch source by `parse` — sys.sql_modules stores it.
      definition: ''
    })
  )

const integerConstant: Parser.t<string> =
  reader => {
    const sign = C.maybe(C.first(C.punct('-'), C.punct('+')))(reader)
    if (Result.failed(sign)) {
      return sign
    }
    const token = Reader.peek(sign.reader)
    if (token?.kind !== 'number' || !/^\d+$/.test(token.value)) {
      return Result.fail(reader, 'Expected an integer constant.')
    }
    return Result.ok(Reader.advanced(sign.reader), `${sign.value ?? ''}${token.value}`)
  }

const sequenceOption: Parser.t<Ast.SequenceOption> =
  C.first(
    C.map(C.seq(C.keyword('start'), C.keyword('with'), integerConstant),
      ([ , , value ]) => ({ kind: 'start' as const, value })),
    C.map(C.seq(C.keyword('increment'), C.keyword('by'), integerConstant),
      ([ , , value ]) => ({ kind: 'increment' as const, value })),
    C.map(C.seq(
      C.keyword('restart'),
      C.maybe(C.map(C.seq(C.keyword('with'), integerConstant), ([ , value ]) => value))
    ), ([ , value ]) => ({ kind: 'restart' as const, ...value === undefined ? {} : { value } })),
    C.map(C.seq(C.keyword('minvalue'), integerConstant),
      ([ , value ]) => ({ kind: 'min' as const, value })),
    C.map(C.keywords('no', 'minvalue'), () => ({ kind: 'min' as const })),
    C.map(C.seq(C.keyword('maxvalue'), integerConstant),
      ([ , value ]) => ({ kind: 'max' as const, value })),
    C.map(C.keywords('no', 'maxvalue'), () => ({ kind: 'max' as const })),
    C.map(C.keyword('cycle'), () => ({ kind: 'cycle' as const, enabled: true })),
    C.map(C.keywords('no', 'cycle'), () => ({ kind: 'cycle' as const, enabled: false })),
    C.map(C.seq(C.keyword('cache'), C.maybe(integerConstant)),
      ([ , size ]) => ({
        kind: 'cache' as const,
        enabled: true,
        ...size === undefined ? {} : { size }
      })),
    C.map(C.keywords('no', 'cache'), () => ({ kind: 'cache' as const, enabled: false }))
  )

const createSequence: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('create'), C.keyword('sequence'), C.qualifiedName,
      C.maybe(C.map(C.seq(C.keyword('as'), typeName), ([ , type ]) => type)),
      C.many0(sequenceOption)
    ),
    ([ , , name, dataType, options ]) => ({
      kind: 'createSequence' as const,
      name,
      ...dataType === undefined ? {} : { dataType },
      options
    })
  )

const alterSequence: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('alter'), C.keyword('sequence'), C.qualifiedName, C.many1(sequenceOption)),
    ([ , , name, options ]) => ({ kind: 'alterSequence' as const, name, options })
  )

const triggerAction: Parser.t<'create' | 'alter' | 'createOrAlter'> =
  C.first(
    C.map(
      C.seq(C.keyword('create'), C.keyword('or'), C.keyword('alter'), C.keyword('trigger')),
      () => 'createOrAlter' as const
    ),
    C.map(C.seq(C.keyword('create'), C.keyword('trigger')), () => 'create' as const),
    C.map(C.seq(C.keyword('alter'), C.keyword('trigger')), () => 'alter' as const)
  )

const triggerTiming: Parser.t<'after' | 'insteadOf'> =
  C.first(
    C.map(C.first(C.keyword('after'), C.keyword('for')), () => 'after' as const),
    C.map(C.seq(C.keyword('instead'), C.keyword('of')), () => 'insteadOf' as const)
  )

const triggerEvent: Parser.t<Ast.TriggerEvent> =
  C.first(C.keyword('insert'), C.keyword('update'), C.keyword('delete')) as Parser.t<Ast.TriggerEvent>

const triggerOption: Parser.t<string> =
  C.first(
    C.map(
      C.seq(
        C.keyword('execute'), C.keyword('as'), C.maybe(C.punct('=')),
        C.first(C.keyword('caller'), C.keyword('self'), C.keyword('owner'), C.anyIdentifier)
      ),
      ([ , , , principal ]) => `execute as ${principal.toLowerCase()}`
    ),
    C.map(C.anyIdentifier, name => name.toLowerCase())
  )

const createTrigger: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      triggerAction,
      C.qualifiedName,
      C.keyword('on'),
      C.qualifiedName,
      C.maybe(C.map(
        C.seq(C.keyword('with'), C.sepBy1(triggerOption, C.punct(','))),
        ([ , options ]) => options
      )),
      triggerTiming,
      C.sepBy1(triggerEvent, C.punct(',')),
      C.maybe(C.seq(C.keyword('with'), C.keyword('append'))),
      C.maybe(C.seq(C.keyword('not'), C.keyword('for'), C.keyword('replication'))),
      C.keyword('as'),
      statementsUntilInputEnd
    ),
    ([ action, name, , target, options, timing, events, append, replication, , body ]) => ({
      kind: 'createTrigger' as const,
      name,
      action,
      target,
      timing,
      events,
      options: [
        ...(options ?? []),
        ...append === undefined ? [] : [ 'append' ],
        ...replication === undefined ? [] : [ 'not for replication' ]
      ],
      body,
      definition: ''
    })
  )

/** Single statement parser. */
export const statement: Parser.t<Ast.Statement> =
  C.first<Parser.t<Ast.Statement>[]>(
    select,
    insert,
    update,
    delete_,
    merge,
    createSequence,
    alterSequence,
    createDatabase,
    alterDatabase,
    createTable,
    createIndex,
    createView,
    createTrigger,
    createProcedure,
    createFunction,
    alterTable,
    dropIndex,
    dropDatabase,
    drop,
    truncate,
    declareCursor,
    declare,
    set,
    beginBlockOrTransaction,
    transaction,
    ifStatement,
    whileStatement,
    execute,
    cursorNameStatement('open', 'openCursor'),
    fetchCursor,
    cursorNameStatement('close', 'closeCursor'),
    cursorNameStatement('deallocate', 'deallocateCursor'),
    use,
    print,
    returnStatement,
    throwStatement,
    raiserror,
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
