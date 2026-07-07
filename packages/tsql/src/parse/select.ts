import * as C from './combinators.ts'
import * as Result from './result.ts'
import { expression, operand, orderByItem, useSelectParser } from './expression.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const alias: Parser.t<string | undefined> =
  C.maybe(C.first(
    C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
    C.identifier
  ))

/** Optional WITH (hints) or bare legacy (NOLOCK) — parsed and ignored. */
export const tableHints: Parser.t<string[] | undefined> =
  C.maybe(C.first(
    C.map(
      C.seq(C.keyword('with'), C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
      ([ , hints ]) => hints
    ),
    // Bare legacy hint — WITH-less (NOLOCK).
    C.map(C.parens(C.keyword('nolock')), hint => [ hint ])
  ))

const tablePrimary: Parser.t<Ast.TableSource> =
  C.first(
    C.map(
      C.seq(C.parens(reader => select(reader)), alias),
      ([ select_, alias_ ]) => ({
        kind: 'derived' as const,
        select: select_,
        alias: alias_ ?? ''
      })
    ),
    C.map(
      C.seq(C.qualifiedName, tableHints, alias, tableHints),
      ([ name, hintsBefore, alias_, hintsAfter ]) => {
        const hints = hintsBefore ?? hintsAfter
        return {
          kind: 'table' as const,
          name,
          ...alias_ === undefined ? {} : { alias: alias_ },
          ...hints === undefined ? {} : { hints }
        }
      }
    )
  )

const joinKind: Parser.t<'inner' | 'left' | 'right' | 'full' | 'cross'> =
  C.first(
    C.map(C.seq(C.keyword('inner'), C.keyword('join')), () => 'inner' as const),
    C.map(C.seq(C.keyword('left'), C.maybe(C.keyword('outer')), C.keyword('join')), () => 'left' as const),
    C.map(C.seq(C.keyword('right'), C.maybe(C.keyword('outer')), C.keyword('join')), () => 'right' as const),
    C.map(C.seq(C.keyword('full'), C.maybe(C.keyword('outer')), C.keyword('join')), () => 'full' as const),
    C.map(C.seq(C.keyword('cross'), C.keyword('join')), () => 'cross' as const),
    C.map(C.keyword('join'), () => 'inner' as const)
  )

/** Table source with joins, left-associative. */
export const tableSource: Parser.t<Ast.TableSource> =
  reader => {
    const head = tablePrimary(reader)
    if (Result.failed(head)) {
      return head
    }
    let left = head.value
    let current = head.reader
    for (;;) {
      const kind = joinKind(current)
      if (Result.failed(kind)) {
        break
      }
      const right = tablePrimary(kind.reader)
      if (Result.failed(right)) {
        return right
      }
      if (kind.value === 'cross') {
        left = { kind: 'join', join: 'cross', left, right: right.value }
        current = right.reader
        continue
      }
      const on = C.seq(C.keyword('on'), expression)(right.reader)
      if (Result.failed(on)) {
        return on
      }
      left = { kind: 'join', join: kind.value, left, right: right.value, on: on.value[1] }
      current = on.reader
    }
    return Result.ok(current, left)
  }

const selectItem: Parser.t<Ast.SelectItem> =
  C.first(
    // Qualified or bare star: t.* or *.
    C.map(
      C.seq(C.qualifiedName, C.punct('.'), C.punct('*')),
      ([ qualifier ]) => ({ kind: 'star' as const, qualifier })
    ),
    C.map(C.punct('*'), () => ({ kind: 'star' as const })),
    // Variable assignment: @x = expression, @x += expression.
    C.map(
      C.seq(
        C.variable,
        C.first(...[ '=', '+=', '-=', '*=', '/=', '%=' ].map(C.punct)),
        expression
      ),
      ([ variable, operator, expression_ ]) => ({
        kind: 'assign' as const,
        variable,
        operator,
        expression: expression_
      })
    ),
    // Alias-first form: alias = expression.
    C.map(
      C.seq(C.identifier, C.punct('='), expression),
      ([ alias_, , expression_ ]) => ({
        kind: 'expression' as const,
        expression: expression_,
        alias: alias_
      })
    ),
    // Expression with optional alias, or string literal alias ('x' = per T-SQL is alias too — skip).
    C.map(
      C.seq(expression, alias),
      ([ expression_, alias_ ]) => ({
        kind: 'expression' as const,
        expression: expression_,
        ...alias_ === undefined ? {} : { alias: alias_ }
      })
    )
  )

const top: Parser.t<Ast.Select['top']> =
  C.map(
    C.seq(
      C.keyword('top'),
      C.first(
        C.parens(expression),
        operand
      ),
      C.maybe(C.keyword('percent')),
      C.maybe(C.seq(C.keyword('with'), C.keyword('ties')))
    ),
    ([ , count, percent, ties ]) => ({
      count,
      percent: percent !== undefined,
      ...ties === undefined ? {} : { withTies: true }
    })
  )

const cte: Parser.t<Ast.Cte> =
  C.map(
    C.seq(
      C.anyIdentifier,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))),
      C.keyword('as'),
      C.parens(reader => select(reader))
    ),
    ([ name, columns, , select_ ]) => ({
      name,
      ...columns === undefined ? {} : { columns },
      select: select_
    })
  )

const selectCore: Parser.t<Ast.Select> =
  reader => {
    const start = C.seq(
      C.keyword('select'),
      C.maybe(C.first(C.keyword('distinct'), C.keyword('all'))),
      C.maybe(top),
      C.sepBy1(selectItem, C.punct(','))
    )(reader)
    if (Result.failed(start)) {
      return start
    }
    const [ , distinct, top_, items ] = start.value
    const into = C.maybe(C.map(C.seq(C.keyword('into'), C.qualifiedName), ([ , name ]) => name))(start.reader)
    if (Result.failed(into)) {
      return into
    }
    const from = C.maybe(C.map(
      C.seq(C.keyword('from'), C.sepBy1(tableSource, C.punct(','))),
      ([ , sources ]) =>
        sources.reduce((left, right) =>
          ({ kind: 'join' as const, join: 'cross' as const, left, right }))
    ))(into.reader)
    if (Result.failed(from)) {
      return from
    }
    const where = C.maybe(C.map(C.seq(C.keyword('where'), expression), ([ , value ]) => value))(from.reader)
    if (Result.failed(where)) {
      return where
    }
    const groupBy = C.maybe(C.map(
      C.seq(C.keywords('group', 'by'), C.sepBy1(expression, C.punct(','))),
      ([ , values ]) => values
    ))(where.reader)
    if (Result.failed(groupBy)) {
      return groupBy
    }
    const having = C.maybe(C.map(C.seq(C.keyword('having'), expression), ([ , value ]) => value))(groupBy.reader)
    if (Result.failed(having)) {
      return having
    }
    return Result.ok(having.reader, {
      kind: 'select',
      distinct: distinct === 'distinct',
      ...top_ === undefined ? {} : { top: top_ },
      items,
      ...into.value === undefined ? {} : { into: into.value },
      ...from.value === undefined ? {} : { from: from.value },
      ...where.value === undefined ? {} : { where: where.value },
      ...groupBy.value === undefined ? {} : { groupBy: groupBy.value },
      ...having.value === undefined ? {} : { having: having.value }
    })
  }

const unionKind: Parser.t<'union' | 'unionAll' | 'except' | 'intersect'> =
  C.first(
    C.map(C.seq(C.keyword('union'), C.keyword('all')), () => 'unionAll' as const),
    C.map(C.keyword('union'), () => 'union' as const),
    C.map(C.keyword('except'), () => 'except' as const),
    C.map(C.keyword('intersect'), () => 'intersect' as const)
  )

/** Full SELECT parser — CTEs, set operations, ORDER BY with OFFSET/FETCH. */
export const select: Parser.t<Ast.Select> =
  reader => {
    const ctes = C.maybe(C.map(
      C.seq(C.keyword('with'), C.sepBy1(cte, C.punct(','))),
      ([ , values ]) => values
    ))(reader)
    if (Result.failed(ctes)) {
      return ctes
    }
    const head = selectCore(ctes.reader)
    if (Result.failed(head)) {
      return head
    }
    // Set operations, right-nested.
    let core = head.value
    let current = head.reader
    const unions: { kind: 'union' | 'unionAll' | 'except' | 'intersect', select: Ast.Select }[] = []
    for (;;) {
      const kind = unionKind(current)
      if (Result.failed(kind)) {
        break
      }
      const next = selectCore(kind.reader)
      if (Result.failed(next)) {
        return next
      }
      unions.push({ kind: kind.value, select: next.value })
      current = next.reader
    }
    for (let i = unions.length - 1; i >= 1; i--) {
      const outer = unions[i - 1]
      const inner = unions[i]
      if (outer !== undefined && inner !== undefined) {
        unions[i - 1] = {
          kind: outer.kind,
          select: { ...outer.select, union: inner }
        }
      }
    }
    const firstUnion = unions[0]
    if (firstUnion !== undefined) {
      core = { ...core, union: firstUnion }
    }
    const orderBy = C.maybe(C.map(
      C.seq(C.keywords('order', 'by'), C.sepBy1(orderByItem, C.punct(','))),
      ([ , items ]) => items
    ))(current)
    if (Result.failed(orderBy)) {
      return orderBy
    }
    current = orderBy.reader
    let offsetFetch: { offset: Ast.Expression, fetch?: Ast.Expression } | undefined
    const offset = C.seq(C.keyword('offset'), operand, C.first(C.keyword('rows'), C.keyword('row')))(current)
    if (!Result.failed(offset)) {
      current = offset.reader
      offsetFetch = { offset: offset.value[1] }
      const fetch = C.seq(
        C.keyword('fetch'),
        C.first(C.keyword('next'), C.keyword('first')),
        operand,
        C.first(C.keyword('rows'), C.keyword('row')),
        C.keyword('only')
      )(current)
      if (!Result.failed(fetch)) {
        current = fetch.reader
        offsetFetch = { offset: offsetFetch.offset, fetch: fetch.value[2] }
      }
    }
    const withCtes = ctes.value === undefined ? core : { ...core, ctes: ctes.value }
    return Result.ok(current, {
      ...withCtes,
      ...orderBy.value === undefined ? {} : { orderBy: orderBy.value },
      ...offsetFetch === undefined ? {} : {
        offset: offsetFetch.offset,
        ...offsetFetch.fetch === undefined ? {} : { fetch: offsetFetch.fetch }
      }
    })
  }

useSelectParser(select)

export default select
