import * as C from './combinators.ts'
import * as Result from './result.ts'
import { expression } from './expression.ts'
import { select, tableHints, tableSource } from './select.ts'
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
          C.tableName,
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
      C.tableName,
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
      C.tableName,
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
      C.tableName,
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

const aliasClause: Parser.t<string | undefined> =
  C.maybe(C.first(
    C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
    C.identifier
  ))

const requiredAlias: Parser.t<string> =
  C.first(
    C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
    C.identifier
  )

// A VALUES table constructor as a right-nested UNION ALL chain whose first
// branch aliases every column — the only rendering SQLite offers for a
// derived table with a column list.
const valuesAsSelect =
  (rows: readonly (readonly Ast.Expression[])[], columns: readonly string[]): Ast.Select => {
    const selects = rows.map((row): Ast.Select => ({
      kind: 'select',
      distinct: false,
      items: row.map((value, index) => ({
        kind: 'expression',
        expression: value,
        alias: columns[index] ?? ''
      }))
    }))
    let chained = selects[selects.length - 1] as Ast.Select
    for (let index = selects.length - 2; index >= 0; index--) {
      chained = { ...selects[index] as Ast.Select, union: { kind: 'unionAll', select: chained } }
    }
    return chained
  }

/**
 * MERGE USING source — a table, a derived SELECT, or a VALUES table
 * constructor. Column lists desugar into select-item aliases.
 */
const mergeSource: Parser.t<Ast.TableSource> =
  reader => {
    const values = C.seq(
      C.parens(C.map(
        C.seq(C.keyword('values'), C.sepBy1(valuesRow, C.punct(','))),
        ([ , rows ]) => rows
      )),
      requiredAlias,
      C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))
    )(reader)
    if (!Result.failed(values)) {
      const [ rows, alias, columns ] = values.value
      if (rows.some(row => row.length !== columns.length)) {
        return Result.fail(reader, 'The VALUES row width must match the source column list.')
      }
      return Result.ok(values.reader, {
        kind: 'derived' as const,
        select: valuesAsSelect(rows, columns),
        alias
      })
    }
    const derived = C.seq(
      C.parens(select),
      requiredAlias,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))))
    )(reader)
    if (!Result.failed(derived)) {
      const [ select_, alias, columns ] = derived.value
      if (columns === undefined) {
        return Result.ok(derived.reader, { kind: 'derived' as const, select: select_, alias })
      }
      if (select_.items.length !== columns.length ||
        select_.items.some(item => item.kind !== 'expression')) {
        return Result.fail(reader, 'The source column list must name every select item.')
      }
      const items = select_.items.map((item, index) =>
        item.kind === 'expression' ? { ...item, alias: columns[index] ?? '' } : item)
      return Result.ok(derived.reader, {
        kind: 'derived' as const,
        select: { ...select_, items },
        alias
      })
    }
    return C.map(
      C.seq(C.qualifiedName, tableHints, aliasClause, tableHints),
      ([ name, hintsBefore, alias, hintsAfter ]) => {
        const hints = hintsBefore ?? hintsAfter
        return {
          kind: 'table' as const,
          name,
          ...alias === undefined ? {} : { alias },
          ...hints === undefined ? {} : { hints }
        }
      }
    )(reader)
  }

const mergeAndCondition: Parser.t<Ast.Expression | undefined> =
  C.maybe(C.map(C.seq(C.keyword('and'), expression), ([ , value ]) => value))

const mergeUpdateOrDelete: Parser.t<Ast.MergeAction> =
  C.first<Parser.t<Ast.MergeAction>[]>(
    C.map(
      C.seq(C.keyword('update'), C.keyword('set'), C.sepBy1(assignment, C.punct(','))),
      ([ , , set ]) => ({ kind: 'update' as const, set })
    ),
    C.map(C.keyword('delete'), () => ({ kind: 'delete' as const }))
  )

const mergeInsert: Parser.t<Ast.MergeAction> =
  C.map(
    C.seq(
      C.keyword('insert'),
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
      C.first(
        C.map(C.seq(C.keyword('values'), valuesRow), ([ , values ]) => values),
        C.map(C.keywords('default', 'values'), () => undefined)
      )
    ),
    ([ , columns, values ]) => ({
      kind: 'insert' as const,
      ...columns === undefined ? {} : { columns },
      ...values === undefined ? {} : { values }
    })
  )

const mergeWhen: Parser.t<Ast.MergeWhen> =
  C.first<Parser.t<Ast.MergeWhen>[]>(
    C.map(
      C.seq(C.keyword('when'), C.keyword('matched'), mergeAndCondition, C.keyword('then'), mergeUpdateOrDelete),
      ([ , , condition, , action ]) => ({
        match: 'matched' as const,
        ...condition === undefined ? {} : { condition },
        action
      })
    ),
    C.map(
      C.seq(
        C.keyword('when'), C.keyword('not'), C.keyword('matched'),
        C.keyword('by'), C.keyword('source'),
        mergeAndCondition, C.keyword('then'), mergeUpdateOrDelete
      ),
      ([ , , , , , condition, , action ]) => ({
        match: 'notMatchedBySource' as const,
        ...condition === undefined ? {} : { condition },
        action
      })
    ),
    C.map(
      C.seq(
        C.keyword('when'), C.keyword('not'), C.keyword('matched'),
        C.maybe(C.seq(C.keyword('by'), C.keyword('target'))),
        mergeAndCondition, C.keyword('then'), mergeInsert
      ),
      ([ , , , , condition, , action ]) => ({
        match: 'notMatchedByTarget' as const,
        ...condition === undefined ? {} : { condition },
        action
      })
    )
  )

const mergeTerminator: Parser.t<string> =
  reader => {
    const terminator = C.punct(';')(reader)
    return Result.failed(terminator) ?
      Result.fail(reader, 'A MERGE statement must be terminated by a semi-colon (;).') :
      terminator
  }

/** MERGE statement parser. */
const mergeStatement: Parser.t<Ast.Statement> =
  C.map(
    C.seq(
      C.keyword('merge'),
      C.maybe(C.keyword('into')),
      C.qualifiedName,
      tableHints,
      aliasClause,
      tableHints,
      C.keyword('using'),
      mergeSource,
      C.keyword('on'),
      expression,
      C.many1(mergeWhen),
      outputClause,
      mergeTerminator
    ),
    ([ , , target, , alias, , , source, , on, whens, output ]) => ({
      kind: 'merge' as const,
      target,
      ...alias === undefined ? {} : { alias },
      source,
      on,
      whens,
      ...output === undefined ? {} : { output }
    })
  )

/** MERGE commits to its SQL Server-specific diagnostics after its keyword. */
export const merge: Parser.t<Ast.Statement> =
  reader => {
    const result = mergeStatement(reader)
    if (!Result.failed(result)) {
      return result
    }
    const prefix = C.keyword('merge')(reader)
    return Result.failed(prefix) ? result : Result.fail(prefix.reader, result.reason)
  }
