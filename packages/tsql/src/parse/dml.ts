import * as C from './combinators.ts'
import { expression } from './expression.ts'
import { select, tableSource } from './select.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const topClause: Parser.t<Ast.Expression | undefined> =
  C.maybe(C.map(
    C.seq(C.keyword('top'), C.parens(expression)),
    ([ , count ]) => count
  ))

const valuesRow: Parser.t<Ast.Expression[]> =
  C.parens(C.sepBy1(expression, C.punct(',')))

// OUTPUT items are select items without the variable-assignment form —
// `@x = expression` is not part of the OUTPUT grammar.
const outputItem: Parser.t<Ast.SelectItem> =
  C.first(
    C.map(
      C.seq(C.qualifiedName, C.punct('.'), C.punct('*')),
      ([ qualifier ]) => ({ kind: 'star' as const, qualifier })
    ),
    C.map(
      C.seq(
        expression,
        C.maybe(C.first(
          C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
          C.identifier
        ))
      ),
      ([ expression_, alias ]) => ({
        kind: 'expression' as const,
        expression: expression_,
        ...alias === undefined ? {} : { alias }
      })
    )
  )

const outputClause: Parser.t<Ast.Output | undefined> =
  C.maybe(C.map(
    C.seq(
      C.keyword('output'),
      C.sepBy1(outputItem, C.punct(',')),
      C.maybe(C.map(
        C.seq(
          C.keyword('into'),
          C.qualifiedName,
          C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))))
        ),
        ([ , table, columns ]) => ({
          table,
          ...columns === undefined ? {} : { columns }
        })
      ))
    ),
    ([ , items, into ]) => ({
      items,
      ...into === undefined ? {} : { into }
    })
  ))

/** INSERT statement parser. */
export const insert: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('insert'),
      C.maybe(C.keyword('into')),
      C.qualifiedName,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
      outputClause,
      C.first(
        C.map(
          C.seq(C.keyword('values'), C.sepBy1(valuesRow, C.punct(','))),
          ([ , rows ]): Ast.InsertSource => ({ kind: 'values', rows })
        ),
        C.map(
          C.keywords('default', 'values'),
          (): Ast.InsertSource => ({ kind: 'defaultValues' })
        ),
        C.map(select, (select_): Ast.InsertSource => ({ kind: 'select', select: select_ }))
      )
    ),
    ([ , , table, columns, output, source ]) => ({
      kind: 'insert' as const,
      table,
      ...columns === undefined ? {} : { columns },
      ...output === undefined ? {} : { output },
      source
    })
  )

const assignmentTarget: Parser.t<{ kind: 'column', name: Ast.QualifiedName } | { kind: 'variable', name: string }> =
  C.first(
    C.map(C.variable, name => ({ kind: 'variable' as const, name })),
    C.map(C.qualifiedName, name => ({ kind: 'column' as const, name }))
  )

const assignment: Parser.t<Ast.Assignment> =
  C.map(
    C.seq(
      assignmentTarget,
      C.first(...[ '=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=' ].map(C.punct)),
      expression
    ),
    ([ target, operator, value ]) => ({ target, operator, value })
  )

/** UPDATE statement parser. */
export const update: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('update'),
      topClause,
      C.qualifiedName,
      C.keyword('set'),
      C.sepBy1(assignment, C.punct(',')),
      outputClause,
      C.maybe(C.map(C.seq(C.keyword('from'), tableSource), ([ , source ]) => source)),
      C.maybe(C.map(C.seq(C.keyword('where'), expression), ([ , value ]) => value))
    ),
    ([ , top, target, , set, output, from, where ]) => ({
      kind: 'update' as const,
      target,
      ...top === undefined ? {} : { top },
      set,
      ...output === undefined ? {} : { output },
      ...from === undefined ? {} : { from },
      ...where === undefined ? {} : { where }
    })
  )

/** DELETE statement parser. */
export const delete_: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('delete'),
      topClause,
      C.maybe(C.keyword('from')),
      C.qualifiedName,
      outputClause,
      C.maybe(C.map(C.seq(C.keyword('from'), tableSource), ([ , source ]) => source)),
      C.maybe(C.map(C.seq(C.keyword('where'), expression), ([ , value ]) => value))
    ),
    ([ , top, , target, output, from, where ]) => ({
      kind: 'delete' as const,
      target,
      ...top === undefined ? {} : { top },
      ...output === undefined ? {} : { output },
      ...from === undefined ? {} : { from },
      ...where === undefined ? {} : { where }
    })
  )

/** TRUNCATE TABLE statement parser. */
export const truncate: Parser.t<Ast.Statement> =
  C.map(
    C.seq(C.keyword('truncate'), C.keyword('table'), C.qualifiedName),
    ([ , , table ]) => ({ kind: 'truncate' as const, table })
  )
