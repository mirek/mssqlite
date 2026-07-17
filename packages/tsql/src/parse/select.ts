import * as C from './combinators.ts'
import * as Reader from './reader.ts'
import * as Result from './result.ts'
import typeName from './type-name.ts'
import { expression, operand, orderByItem, useSelectParser } from './expression.ts'
import type * as Ast from '../ast.ts'
import type * as Parser from './parser.ts'

const alias: Parser.t<string | undefined> =
  C.maybe(C.first(
    C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
    C.identifier
  ))

const requiredAlias: Parser.t<string> =
  C.first(
    C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
    C.anyIdentifier
  )

/** One row of a table value constructor. */
export const valuesRow: Parser.t<Ast.Expression[]> =
  C.parens(C.sepBy1(expression, C.punct(',')))

/** Parenthesized VALUES table source with its required correlation name. */
export const valuesTable: Parser.t<Ast.TableSource> =
  C.map(
    C.seq(
      C.parens(C.map(
        C.seq(C.keyword('values'), C.sepBy1(valuesRow, C.punct(','))),
        ([ , rows ]) => rows
      )),
      requiredAlias,
      C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))))
    ),
    ([ rows, alias_, columns ]) => ({
      kind: 'values' as const,
      rows,
      alias: alias_,
      ...columns === undefined ? {} : { columns }
    })
  )

const tableFunctionColumn: Parser.t<Ast.TableFunctionColumn> =
  reader => {
    const head = C.seq(C.anyIdentifier, typeName)(reader)
    if (Result.failed(head)) {
      return head
    }
    const path = C.maybe(expression)(head.reader)
    if (Result.failed(path)) {
      return path
    }
    if (path.value !== undefined && path.value.kind !== 'string') {
      return Result.fail(head.reader, 'Expected a JSON path string.')
    }
    const asJson = C.maybe(C.seq(C.keyword('as'), C.keyword('json')))(path.reader)
    if (Result.failed(asJson)) {
      return asJson
    }
    return Result.ok(asJson.reader, {
      name: head.value[0],
      type: head.value[1],
      ...path.value === undefined ? {} : { path: path.value.value },
      asJson: asJson.value !== undefined
    })
  }

const tableFunction: Parser.t<Ast.TableSource> =
  C.map(
    C.seq(
      C.qualifiedName,
      C.parens(C.sepBy1(expression, C.punct(','))),
      C.maybe(C.map(
        C.seq(
          C.keyword('with'),
          C.parens(C.sepBy1(tableFunctionColumn, C.punct(',')))
        ),
        ([ , columns ]) => columns
      )),
      C.maybe(C.map(
        C.seq(
          C.first(
            C.map(C.seq(C.keyword('as'), C.anyIdentifier), ([ , name ]) => name),
            C.identifier
          ),
          C.maybe(C.parens(C.sepBy1(C.anyIdentifier, C.punct(','))))
        ),
        ([ name, columns ]) => ({ name, columns })
      ))
    ),
    ([ name, args, with_, alias_ ]) => ({
      kind: 'function' as const,
      name,
      args,
      ...with_ === undefined ? {} : { with: with_ },
      ...alias_ === undefined ? {} : {
        alias: alias_.name,
        ...alias_.columns === undefined ? {} : { columns: alias_.columns }
      }
    })
  )

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
    valuesTable,
    C.map(
      C.seq(C.parens(reader => select(reader)), alias),
      ([ select_, alias_ ]) => ({
        kind: 'derived' as const,
        select: select_,
        alias: alias_ ?? ''
      })
    ),
    tableFunction,
    C.map(
      C.seq(C.tableName, tableHints, alias, tableHints),
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

const pivot =
  (source: Ast.TableSource): Parser.t<Ast.TableSource> =>
    C.map(
      C.seq(
        C.keyword('pivot'),
        C.parens(C.seq(
          C.qualifiedName,
          C.parens(expression),
          C.keyword('for'),
          C.qualifiedName,
          C.keyword('in'),
          C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))
        )),
        requiredAlias
      ),
      ([ , [ name, expression_, , pivotColumn, , values ], alias_ ]) => ({
        kind: 'pivot' as const,
        source,
        aggregate: { name, expression: expression_ },
        pivotColumn,
        values,
        alias: alias_
      })
    )

const unpivot =
  (source: Ast.TableSource): Parser.t<Ast.TableSource> =>
    C.map(
      C.seq(
        C.keyword('unpivot'),
        C.parens(C.seq(
          C.anyIdentifier,
          C.keyword('for'),
          C.anyIdentifier,
          C.keyword('in'),
          C.parens(C.sepBy1(C.anyIdentifier, C.punct(',')))
        )),
        requiredAlias
      ),
      ([ , [ valueColumn, , pivotColumn, , columns ], alias_ ]) => ({
        kind: 'unpivot' as const,
        source,
        valueColumn,
        pivotColumn,
        columns,
        alias: alias_
      })
    )

const tableFactor: Parser.t<Ast.TableSource> =
  reader => {
    const primary = tablePrimary(reader)
    if (Result.failed(primary)) {
      return primary
    }
    let source = primary.value
    let current = primary.reader
    for (;;) {
      const transformed = C.first(pivot(source), unpivot(source))(current)
      if (Result.failed(transformed)) {
        return Result.ok(current, source)
      }
      source = transformed.value
      current = transformed.reader
    }
  }

const emptyGroupingSet: Parser.t<Ast.GroupingSetItem> =
  C.map(C.seq(C.punct('('), C.punct(')')), () => ({
    kind: 'expressions' as const,
    expressions: []
  }))

const groupingUnit: Parser.t<Ast.GroupingUnit> =
  C.first(
    C.parens(C.sepBy1(expression, C.punct(','))),
    C.map(expression, value => [ value ])
  )

const rollup: Parser.t<Ast.GroupingSetItem> =
  C.map(
    C.seq(C.keyword('rollup'), C.parens(C.sepBy1(groupingUnit, C.punct(',')))),
    ([ , units ]) => ({ kind: 'rollup' as const, units })
  )

const cube: Parser.t<Ast.GroupingSetItem> =
  C.map(
    C.seq(C.keyword('cube'), C.parens(C.sepBy1(groupingUnit, C.punct(',')))),
    ([ , units ]) => ({ kind: 'cube' as const, units })
  )

const groupingExpressions: Parser.t<Ast.GroupingSetItem> =
  C.map(groupingUnit, expressions => ({ kind: 'expressions' as const, expressions }))

const groupingSetItem: Parser.t<Ast.GroupingSetItem> =
  C.first(emptyGroupingSet, rollup, cube, groupingExpressions)

const groupingSets: Parser.t<Ast.GroupByItem> =
  C.map(
    C.seq(
      C.keywords('grouping', 'sets'),
      C.parens(C.sepBy1(groupingSetItem, C.punct(',')))
    ),
    ([ , sets ]) => ({ kind: 'sets' as const, sets })
  )

const groupByItem: Parser.t<Ast.GroupByItem> =
  reader => {
    const token = Reader.peek(reader)
    const keyword = token?.kind === 'word' ? token.value.toLowerCase() : undefined
    switch (keyword) {
      case 'grouping':
        return groupingSets(reader)
      case 'rollup':
        return rollup(reader)
      case 'cube':
        return cube(reader)
      default:
        return C.first(emptyGroupingSet, groupingExpressions)(reader)
    }
  }

type ForJsonOption =
  | { readonly kind: 'root', readonly name: string }
  | { readonly kind: 'includeNullValues' }
  | { readonly kind: 'withoutArrayWrapper' }

const rootOption: Parser.t<ForJsonOption> =
  reader => {
    const root = C.keyword('root')(reader)
    if (Result.failed(root)) {
      return root
    }
    const name = C.maybe(C.parens(expression))(root.reader)
    if (Result.failed(name)) {
      return name
    }
    if (name.value !== undefined && name.value.kind !== 'string') {
      return Result.fail(root.reader, 'FOR JSON ROOT expects a string literal.')
    }
    return Result.ok(name.reader, {
      kind: 'root',
      name: name.value?.kind === 'string' ? name.value.value : 'root'
    })
  }

const forJsonOption: Parser.t<ForJsonOption> =
  C.first(
    rootOption,
    C.map(C.keyword('include_null_values'), () => ({ kind: 'includeNullValues' as const })),
    C.map(C.keyword('without_array_wrapper'), () => ({ kind: 'withoutArrayWrapper' as const }))
  )

const forJson: Parser.t<Ast.ForJson> =
  reader => {
    const parsed = C.seq(
      C.keywords('for', 'json'),
      C.first(C.keyword('path'), C.keyword('auto')),
      C.many0(C.map(C.seq(C.punct(','), forJsonOption), ([ , option ]) => option))
    )(reader)
    if (Result.failed(parsed)) {
      return parsed
    }
    const [ , mode, options ] = parsed.value
    if (new Set(options.map(option => option.kind)).size !== options.length) {
      return Result.fail(reader, 'FOR JSON options cannot be repeated.')
    }
    const root = options.find((option): option is ForJsonOption & { kind: 'root' } =>
      option.kind === 'root')
    return Result.ok(parsed.reader, {
      mode: mode as 'path' | 'auto',
      ...root === undefined ? {} : { root: root.name },
      includeNullValues: options.some(option => option.kind === 'includeNullValues'),
      withoutArrayWrapper: options.some(option => option.kind === 'withoutArrayWrapper')
    })
  }

const joinKind: Parser.t<'inner' | 'left' | 'right' | 'full' | 'cross' | 'crossApply' | 'outerApply'> =
  C.first(
    C.map(C.seq(C.keyword('cross'), C.keyword('apply')), () => 'crossApply' as const),
    C.map(C.seq(C.keyword('outer'), C.keyword('apply')), () => 'outerApply' as const),
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
    const head = tableFactor(reader)
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
      const right = tableFactor(kind.reader)
      if (Result.failed(right)) {
        return right
      }
      if (kind.value === 'cross' || kind.value === 'crossApply' || kind.value === 'outerApply') {
        left = { kind: 'join', join: kind.value, left, right: right.value }
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
      C.seq(C.keywords('group', 'by'), C.sepBy1(groupByItem, C.punct(','))),
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
    const json = C.maybe(forJson)(current)
    if (Result.failed(json)) {
      return json
    }
    current = json.reader
    const withCtes = ctes.value === undefined ? core : { ...core, ctes: ctes.value }
    return Result.ok(current, {
      ...withCtes,
      ...orderBy.value === undefined ? {} : { orderBy: orderBy.value },
      ...offsetFetch === undefined ? {} : {
        offset: offsetFetch.offset,
        ...offsetFetch.fetch === undefined ? {} : { fetch: offsetFetch.fetch }
      },
      ...json.value === undefined ? {} : { forJson: json.value }
    })
  }

useSelectParser(select)

export default select
