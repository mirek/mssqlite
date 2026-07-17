import * as Context from './context.ts'
import * as Collation from './collation.ts'
import * as Character from './character.ts'
import * as Decimal from './decimal.ts'
import * as DateTimeOffset from './datetimeoffset.ts'
import * as ForJson from './for-json.ts'
import * as Grouping from './grouping.ts'
import * as Implicit from './implicit.ts'
import * as Output from './output.ts'
import * as Quote from './quote.ts'
import * as TableFunction from './table-function.ts'
import * as TableTransform from './table-transform.ts'
import * as Type from './type.ts'
import expression, { useSelectRender } from './expression.ts'
import { unsupported } from './error.ts'
import type { Ast, TypeName } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

type ApplyPair = {
  readonly left: Ast.Expression,
  readonly right: Ast.Expression
}

const sourceQualifiers =
  (source: Ast.TableSource): Set<string> => {
    switch (source.kind) {
      case 'table':
        return new Set([ (source.alias ?? source.name[source.name.length - 1] ?? '').toLowerCase() ])
      case 'derived':
        return new Set([ source.alias.toLowerCase() ])
      case 'values':
        return new Set([ source.alias.toLowerCase() ])
      case 'function':
        return new Set([ (source.alias ?? source.name[source.name.length - 1] ?? '').toLowerCase() ])
      case 'pivot':
      case 'unpivot':
        return new Set([ source.alias.toLowerCase() ])
      case 'join':
        return new Set([ ...sourceQualifiers(source.left), ...sourceQualifiers(source.right) ])
      default:
        return new Set()
    }
  }

const andTerms =
  (value: Ast.Expression): readonly Ast.Expression[] =>
    value.kind === 'binaryOp' && value.operator === 'and' ?
      [ ...andTerms(value.left), ...andTerms(value.right) ] :
      [ value ]

const andExpression =
  (values: readonly Ast.Expression[]): Ast.Expression | undefined =>
    values.reduce<Ast.Expression | undefined>((left, right) =>
      left === undefined ? right : { kind: 'binaryOp', operator: 'and', left, right }, undefined)

const qualifierOf =
  (value: Ast.Expression): string | undefined =>
    value.kind === 'column' && value.name.length > 1 ?
      value.name[value.name.length - 2]?.toLowerCase() :
      undefined

const applyPair =
  (term: Ast.Expression, left: ReadonlySet<string>, right: string): ApplyPair | undefined => {
    if (term.kind !== 'binaryOp' || term.operator !== '=') {
      return undefined
    }
    const a = qualifierOf(term.left)
    const b = qualifierOf(term.right)
    if (a !== undefined && left.has(a) && b === right) {
      return { left: term.left, right: term.right }
    }
    if (b !== undefined && left.has(b) && a === right) {
      return { left: term.right, right: term.left }
    }
    if (a === undefined && b !== undefined && left.has(b)) {
      return { left: term.right, right: term.left }
    }
    if (b === undefined && a !== undefined && left.has(a)) {
      return { left: term.left, right: term.right }
    }
    return undefined
  }

const simpleDerivedApply =
  (
    ctx: Context.t,
    leftSource: Ast.TableSource,
    rightSource: Ast.TableSource & { kind: 'derived' },
    outer: boolean
  ): string => {
    const select_ = rightSource.select
    if (select_.top !== undefined || select_.from?.kind !== 'table' ||
      select_.groupBy !== undefined || select_.having !== undefined || select_.union !== undefined ||
      select_.offset !== undefined || select_.fetch !== undefined || select_.orderBy !== undefined) {
      return unsupported('APPLY derived tables require a simple correlated SELECT or SELECT TOP (1).')
    }
    const rightQualifier = (select_.from.alias ??
      select_.from.name[select_.from.name.length - 1] ?? '').toLowerCase()
    const terms = select_.where === undefined ? [] : andTerms(select_.where)
    const leftQualifiers = sourceQualifiers(leftSource)
    const pairs: ApplyPair[] = []
    const remaining: Ast.Expression[] = []
    for (const term of terms) {
      const pair = applyPair(term, leftQualifiers, rightQualifier)
      if (pair === undefined) {
        remaining.push(term)
      } else {
        pairs.push(pair)
      }
    }
    const remainingWhere = andExpression(remaining)
    const { where: _where, ...base } = select_
    const projected: Ast.Select = {
      ...base,
      ...remainingWhere === undefined ? {} : { where: remainingWhere },
      items: [
        ...select_.items,
        ...pairs.map((pair, index): Ast.SelectItem => ({
          kind: 'expression',
          expression: pair.right,
          alias: `__mssqlite_apply_key_${index}`
        }))
      ]
    }
    const left = tableSource(ctx, leftSource)
    const right = `(${select(ctx, projected)}) AS ${Quote.identifier(rightSource.alias)}`
    if (pairs.length === 0) {
      return outer ? `${left} LEFT JOIN ${right} ON TRUE` : `${left} CROSS JOIN ${right}`
    }
    const conditions = pairs.map((pair, index): Ast.Expression => ({
      kind: 'binaryOp',
      operator: '=',
      left: pair.left,
      right: { kind: 'column', name: [ rightSource.alias, `__mssqlite_apply_key_${index}` ] }
    }))
    return `${left} ${outer ? 'LEFT' : 'INNER'} JOIN ${right} ON ` +
      expression(ctx, andExpression(conditions) ?? { kind: 'null' })
  }

const topOneApply =
  (ctx: Context.t, leftSource: Ast.TableSource, rightSource: Ast.TableSource & { kind: 'derived' }, outer: boolean): string => {
    const select_ = rightSource.select
    if (select_.top?.count.kind !== 'number' || Number(select_.top.count.value) !== 1 ||
      select_.top.percent || select_.top.withTies === true || select_.from?.kind !== 'table' ||
      select_.groupBy !== undefined || select_.having !== undefined || select_.union !== undefined ||
      select_.offset !== undefined || select_.fetch !== undefined) {
      return unsupported('APPLY derived tables require a simple correlated SELECT TOP (1).')
    }
    const rightQualifier = (select_.from.alias ??
      select_.from.name[select_.from.name.length - 1] ?? '').toLowerCase()
    const terms = select_.where === undefined ? [] : andTerms(select_.where)
    const leftQualifiers = sourceQualifiers(leftSource)
    const pairs: ApplyPair[] = []
    const remaining: Ast.Expression[] = []
    for (const term of terms) {
      const pair = applyPair(term, leftQualifiers, rightQualifier)
      if (pair === undefined) {
        remaining.push(term)
      } else {
        pairs.push(pair)
      }
    }
    if (pairs.length === 0) {
      return unsupported('APPLY TOP (1) requires an equality correlation in WHERE.')
    }
    const { top: _top, orderBy: _orderBy, where: _where, ...base } = select_
    const remainingWhere = andExpression(remaining)
    const ranked: Ast.Select = {
      ...base,
      ...remainingWhere === undefined ? {} : { where: remainingWhere },
      items: [
        ...select_.items,
        ...pairs.map((pair, index): Ast.SelectItem => ({
          kind: 'expression', expression: pair.right, alias: `__mssqlite_apply_key_${index}`
        })),
        {
          kind: 'expression',
          expression: {
            kind: 'call',
            name: [ 'row_number' ],
            args: [],
            over: {
              partitionBy: pairs.map(pair => pair.right),
              orderBy: select_.orderBy ?? []
            }
          },
          alias: '__mssqlite_apply_rank'
        }
      ]
    }
    const left = tableSource(ctx, leftSource)
    const right = `(${select(ctx, ranked)}) AS ${Quote.identifier(rightSource.alias)}`
    const conditions = [
      ...pairs.map((pair, index): Ast.Expression => ({
        kind: 'binaryOp',
        operator: '=',
        left: pair.left,
        right: { kind: 'column', name: [ rightSource.alias, `__mssqlite_apply_key_${index}` ] }
      })),
      {
        kind: 'binaryOp' as const,
        operator: '=',
        left: { kind: 'column' as const, name: [ rightSource.alias, '__mssqlite_apply_rank' ] },
        right: { kind: 'number' as const, value: '1' }
      }
    ]
    const on = andExpression(conditions) ?? { kind: 'null' }
    return `${left} ${outer ? 'LEFT' : 'INNER'} JOIN ${right} ON ${expression(ctx, on)}`
  }

const valuesSource =
  (ctx: Context.t, source: Ast.TableSource & { kind: 'values' }): string => {
    const names = source.columns ?? source.rows[0]?.map((_value, index) => `column${index + 1}`) ?? []
    const rows = source.rows.map(row => `(${row.map((value, index) => {
      const from = Implicit.typeOf(ctx, value)
      const to = source.columnMetadata?.[index]?.type
      const coerced = from === undefined || to === undefined || Implicit.same(from, to) ?
        value : Implicit.coerce(value, from, to)
      return expression(ctx, coerced)
    }).join(', ')})`).join(', ')
    const columns = names.map((name, index) =>
      `column${index + 1} AS ${Quote.identifier(name)}`).join(', ')
    return `(SELECT ${columns} FROM (VALUES ${rows})) AS ${Quote.identifier(source.alias)}`
  }

const tableSource =
  (ctx: Context.t, source: Ast.TableSource): string => {
    switch (source.kind) {
      case 'table': {
        const object = Quote.objectName(source.name)
        const tablePart = source.name[source.name.length - 1] ?? ''
        // When flattening changes the exposed name (schema-qualified or temp
        // tables), alias back to the bare table name so `orders.id` and
        // `sales.orders.id` still resolve.
        const alias = source.alias !== undefined ?
          ` AS ${Quote.identifier(source.alias)}` :
          object === Quote.identifier(tablePart) ?
            '' :
            ` AS ${Quote.identifier(tablePart)}`
        return `${object}${alias}`
      }
      case 'function':
        return TableFunction.source(ctx, source, expression)
      case 'derived':
        return `(${select(ctx, source.select)}) AS ${Quote.identifier(source.alias)}`
      case 'values':
        return valuesSource(ctx, source)
      case 'pivot':
        return TableTransform.pivot(ctx, source, tableSource, expression)
      case 'unpivot':
        return TableTransform.unpivot(ctx, source, tableSource)
      case 'join': {
        const left = tableSource(ctx, source.left)
        if (source.join === 'crossApply' || source.join === 'outerApply') {
          if (source.right.kind === 'derived') {
            return source.right.select.top === undefined ?
              simpleDerivedApply(ctx, source.left, source.right, source.join === 'outerApply') :
              topOneApply(ctx, source.left, source.right, source.join === 'outerApply')
          }
          if (source.right.kind === 'values') {
            return `${left} CROSS JOIN ${tableSource(ctx, source.right)}`
          }
          if (source.right.kind !== 'function') {
            return unsupported('APPLY requires a supported TVF or correlated SELECT TOP (1).')
          }
          const right = TableFunction.applySource(ctx, source.right, expression)
          return source.join === 'crossApply' ?
            `${left} CROSS JOIN ${right}` :
            `${left} LEFT JOIN ${right} ON TRUE`
        }
        const right = tableSource(ctx, source.right)
        switch (source.join) {
          case 'cross':
            return `${left} CROSS JOIN ${right}`
          case 'full':
            return `${left} FULL JOIN ${right} ON ${expression(ctx, source.on ?? { kind: 'null' })}`
          default:
            return `${left} ${source.join.toUpperCase()} JOIN ${right} ON ${expression(ctx, source.on ?? { kind: 'null' })}`
        }
      }
      default:
        return unsupported('Unsupported table source.')
    }
  }

const selectItem =
  (ctx: Context.t, item: Ast.SelectItem): string => {
    switch (item.kind) {
      case 'star':
        return item.qualifier === undefined ?
          '*' :
          `${Quote.identifier(item.qualifier[item.qualifier.length - 1] ?? '')}.*`
      case 'expression': {
        const alias = item.alias === undefined ? '' : ` AS ${Quote.identifier(item.alias)}`
        return `${expression(ctx, item.expression)}${alias}`
      }
      case 'assign':
        // Variable-assignment items are rewritten by the engine; render the value.
        return expression(ctx, item.expression)
      default:
        return unsupported('Unsupported select item.')
    }
  }

const relationalKey =
  (ctx: Context.t, value: Ast.Expression, rendered: string = expression(ctx, value)): string => {
    const type = Implicit.typeOf(ctx, value)
    if (type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '')) {
      return Collation.expressionKey(rendered, Collation.ofExpression(ctx, value) ?? Collation.default_)
    }
    const offset = DateTimeOffset.scaleOf(ctx, value)
    if (offset !== undefined) {
      return DateTimeOffset.key(rendered)
    }
    const decimal = Decimal.typeOf(ctx, value)
    return decimal === undefined ? rendered : `mssqlite_decimal_sort_key(${rendered}, ${decimal.scale})`
  }

const starExpressions =
  (source: Ast.TableSource | undefined, qualifier: Ast.QualifiedName | undefined): readonly Ast.Expression[] => {
    if (source === undefined) {
      return []
    }
    if (source.kind === 'join') {
      return [ ...starExpressions(source.left, qualifier), ...starExpressions(source.right, qualifier) ]
    }
    if (source.kind !== 'table' && source.kind !== 'values') {
      return []
    }
    const alias = source.kind === 'table' ?
      source.alias ?? source.name[source.name.length - 1] ?? '' : source.alias
    const requested = qualifier?.[qualifier.length - 1]?.toLowerCase()
    if (requested !== undefined && alias.toLowerCase() !== requested) {
      return []
    }
    const columns = source.kind === 'table' ? source.columns : source.columnMetadata
    return columns?.map(column => ({ kind: 'column', name: [ alias, column.name ] })) ?? []
  }

const orderBy =
  (ctx: Context.t, items: readonly Ast.OrderBy[], select_?: Ast.Select): string =>
    Context.withSourceTypes(ctx, select_?.from, () => `ORDER BY ${items
      .map(item => {
        const alias = item.expression.kind === 'column' && item.expression.name.length === 1 ?
          item.expression.name[0]?.toLowerCase() : undefined
        const value = alias === undefined ? undefined :
          select_?.items.find(candidate => candidate.kind === 'expression' &&
            candidate.alias?.toLowerCase() === alias)
        const resolved = value?.kind === 'expression' ? value.expression : item.expression
        const rendered = expression(ctx, item.expression)
        const key = relationalKey(ctx, resolved, rendered)
        return `${key}${item.descending ? ' DESC' : ''}`
      })
      .join(', ')}`)

const selectCore =
  (ctx: Context.t, select_: Ast.Select): string => Context.withSourceTypes(ctx, select_.from, () => {
    const applyAliases = (source: Ast.TableSource | undefined): string[] =>
      source?.kind !== 'join' ?
        [] :
        [
          ...source.join.endsWith('Apply') && source.right.kind === 'derived' ?
            [ source.right.alias.toLowerCase() ] :
            [],
          ...applyAliases(source.left),
          ...applyAliases(source.right)
        ]
    const hidden = applyAliases(select_.from)
    if (hidden.length > 0 && select_.items.some(item =>
      item.kind === 'star' && (item.qualifier === undefined ||
        hidden.includes((item.qualifier[item.qualifier.length - 1] ?? '').toLowerCase())))) {
      return unsupported('SELECT * over a rewritten TOP (1) APPLY source is not supported.')
    }
    const distinctExpressions = select_.items.flatMap(item => item.kind === 'expression' ?
      [ item.expression ] : item.kind === 'star' ? starExpressions(select_.from, item.qualifier) : [])
    const distinctKeys = select_.distinct && select_.groupBy === undefined && distinctExpressions.length > 0 &&
      select_.items.every(item => item.kind !== 'assign' &&
        (item.kind !== 'expression' || !Grouping.containsAggregate(item.expression))) ?
      distinctExpressions.map(value => relationalKey(ctx, value)) : undefined
    const parts: string[] = [
      'SELECT',
      ...select_.distinct && distinctKeys === undefined ? [ 'DISTINCT' ] : [],
      select_.items.map(item => selectItem(ctx, item)).join(', ')
    ]
    if (select_.from !== undefined) {
      parts.push(`FROM ${tableSource(ctx, select_.from)}`)
    }
    if (select_.where !== undefined) {
      parts.push(`WHERE ${expression(ctx, select_.where)}`)
    }
    if (select_.groupBy !== undefined) {
      const values = Grouping.ordinary(select_.groupBy)
      if (values === undefined) {
        return unsupported('Advanced grouping must be expanded before rendering.')
      }
      parts.push(`GROUP BY ${values.map(value => relationalKey(ctx, value)).join(', ')}`)
    } else if (distinctKeys !== undefined) {
      parts.push(`GROUP BY ${distinctKeys.join(', ')}`)
    }
    if (select_.having !== undefined) {
      parts.push(`HAVING ${expression(ctx, select_.having)}`)
    }
    return parts.join(' ')
  })

// ORDER BY keys with select-list aliases substituted by their expressions, so
// the keys stay valid inside a derived subquery that replaces the select list.
const orderKeys =
  (select_: Ast.Select): readonly Ast.OrderBy[] =>
    (select_.orderBy ?? []).map(item => {
      if (item.expression.kind === 'column' && item.expression.name.length === 1) {
        const name = (item.expression.name[0] ?? '').toLowerCase()
        const aliased = select_.items.find(candidate =>
          candidate.kind === 'expression' && candidate.alias?.toLowerCase() === name)
        if (aliased !== undefined && aliased.kind === 'expression') {
          return { ...item, expression: aliased.expression }
        }
      }
      return item
    })

// TOP row budget as a LIMIT expression. PERCENT counts the underlying rows at
// run time via a scalar subquery; WITH TIES widens the budget to every row
// whose RANK() over the ORDER BY keys fits within it.
const topLimit =
  (ctx: Context.t, select_: Ast.Select): string => {
    const top = select_.top
    if (top === undefined) {
      return unsupported('TOP is missing.')
    }
    const { top: _top, orderBy: _orderBy, union: _union, ctes: _ctes, ...bare } = select_
    let budget = expression(ctx, top.count)
    if (top.percent) {
      // DISTINCT needs the real select list to count distinct rows; otherwise
      // a constant keeps the count subquery free of duplicate-name issues.
      const counted = selectCore(ctx, select_.distinct ?
        bare :
        { ...bare, items: [ { kind: 'expression', expression: { kind: 'number', value: '1' } } ] })
      budget = `(SELECT CAST(ceiling(COUNT(*) * (${budget}) / 100.0) AS INTEGER) FROM (${counted}))`
    }
    if (top.withTies !== true) {
      return budget
    }
    if (select_.orderBy === undefined) {
      return unsupported('TOP ... WITH TIES requires ORDER BY.')
    }
    if (select_.distinct) {
      return unsupported('SELECT DISTINCT TOP ... WITH TIES is not supported.')
    }
    const rank: Ast.Expression = {
      kind: 'call',
      name: [ 'rank' ],
      args: [],
      over: { partitionBy: [], orderBy: orderKeys(select_) }
    }
    const ranked = selectCore(ctx, {
      ...bare,
      items: [ { kind: 'expression', expression: rank, alias: '__mssqlite_rank' } ]
    })
    return `(SELECT COUNT(*) FROM (${ranked}) WHERE "__mssqlite_rank" <= ${budget})`
  }

// A TOP inside a set operation is branch-scoped, so wrap that branch's core
// in a LIMIT subquery; SQLite otherwise cannot LIMIT a single compound term.
const setTerm =
  (ctx: Context.t, term: Ast.Select): string => {
    const core = selectCore(ctx, term)
    return term.top === undefined ?
      core :
      `SELECT * FROM (${core} LIMIT ${topLimit(ctx, term)})`
  }

const cteDefinitions =
  (ctx: Context.t, ctes: readonly Ast.Cte[]): string[] =>
    ctes.map(cte => {
      const columns = cte.columns === undefined ?
        '' :
        ` (${cte.columns.map(Quote.identifier).join(', ')})`
      return `${Quote.identifier(cte.name)}${columns} AS (${select(ctx, cte.select)})`
    })

const sourceAlias =
  (source: Ast.TableSource): string | undefined => {
    switch (source.kind) {
      case 'table':
      case 'function':
        return source.alias ?? source.name[source.name.length - 1]
      case 'derived':
      case 'values':
      case 'pivot':
      case 'unpivot':
        return source.alias
      default:
        return undefined
    }
  }

const groupingSelect =
  (ctx: Context.t, select_: Ast.Select): string => {
    if (select_.union !== undefined || select_.distinct || select_.top !== undefined ||
      select_.offset !== undefined || select_.fetch !== undefined || select_.into !== undefined) {
      return unsupported(
        'Advanced grouping with DISTINCT, TOP, INTO, set operations, or OFFSET/FETCH is not supported.')
    }
    const {
      ctes: _ctes,
      orderBy: _orderBy,
      union: _union,
      top: _top,
      offset: _offset,
      fetch: _fetch,
      ...core
    } = select_
    const definitions = cteDefinitions(ctx, select_.ctes ?? [])
    let branchBase: Ast.Select = core
    if (select_.from !== undefined && select_.from.kind !== 'join') {
      const name = `__mssqlite_grouping_${ctx.nextSource++}`
      const where = select_.where === undefined ? '' : ` WHERE ${expression(ctx, select_.where)}`
      const sourceColumns = declaredSourceColumns(select_.from)
      definitions.push(
        `${Quote.identifier(name)} AS MATERIALIZED (SELECT * FROM ${tableSource(ctx, select_.from)}${where})`)
      const alias = sourceAlias(select_.from)
      const { where: _where, ...withoutWhere } = core
      branchBase = {
        ...withoutWhere,
        from: {
          kind: 'table',
          name: [ name ],
          ...sourceColumns === undefined ? {} : { columns: sourceColumns },
          ...alias === undefined ? {} : { alias }
        }
      }
    }
    const sets = Grouping.expand(select_.groupBy ?? [])
    const branches = sets.map(set => selectCore(ctx, Grouping.branch(branchBase, set)))
    const with_ = definitions.length === 0 ? '' : `WITH ${definitions.join(', ')} `
    const order = select_.orderBy === undefined ? '' : ` ${orderBy(ctx, select_.orderBy)}`
    return `${with_}${branches.join(' UNION ALL ')}${order}`
  }

const coercedSet =
  (ctx: Context.t, select_: Ast.Select): Ast.Select => {
    const terms: Ast.Select[] = []
    for (let term: Ast.Select | undefined = select_; term !== undefined; term = term.union?.select) {
      terms.push(term)
    }
    const width = terms[0]?.items.length ?? 0
    if (width === 0 || terms.some(term => term.items.length !== width ||
      term.items.some(item => item.kind !== 'expression'))) {
      return select_
    }
    const inferred = terms.map(term => Context.withSourceTypes(ctx, term.from, () =>
      term.items.map(item => item.kind === 'expression' ? Implicit.typeOf(ctx, item.expression) : undefined)))
    const targets = Array.from({ length: width }, (_unused, index) =>
      Implicit.commonTypes(inferred.flatMap(types => types[index] ?? [])))
    const converted = terms.map((term, termIndex) => ({
      ...term,
      items: term.items.map((item, index): Ast.SelectItem => {
        const target = targets[index]
        const source = inferred[termIndex]?.[index]
        return item.kind !== 'expression' || target === undefined ||
          (source !== undefined && Implicit.same(source, target)) ? item : {
            ...item,
            expression: source === undefined ? item.expression :
              Implicit.coerce(item.expression, source, target)
          }
      })
    }))
    const linked = (index: number): Ast.Select => {
      const term = converted[index] as Ast.Select
      const { union: _discarded, ...bare } = term
      const union = terms[index]?.union
      return union === undefined ? bare : {
        ...bare,
        union: { ...union, select: linked(index + 1) }
      }
    }
    return linked(0)
  }

const declaredSourceColumns =
  (source: Ast.TableSource): readonly Ast.SourceColumn[] | undefined =>
    source.kind === 'table' ? source.columns :
      source.kind === 'values' ? source.columnMetadata : undefined

const setProjectionName =
  (item: Ast.SelectItem, index: number): string =>
    item.kind !== 'expression' ? `column${index + 1}` :
      item.alias ?? (item.expression.kind === 'column' ?
        item.expression.name[item.expression.name.length - 1] ?? `column${index + 1}` : `column${index + 1}`)

const collationSet =
  (ctx: Context.t, terms: readonly Ast.Select[], index: number): string => {
    const values = terms.flatMap(term => Context.withSourceTypes(ctx, term.from, () => {
      const item = term.items[index]
      return item?.kind === 'expression' ? [ item.expression ] : []
    }))
    const explicit = values.flatMap(value => value.kind === 'collate' ?
      [ Collation.key(value.collation) ] : [])
    const declared = values.flatMap(value => Collation.ofExpression(ctx, value) ?? [])
    const names = explicit.length > 0 ? explicit : declared
    const distinct = [ ...new Set(names) ]
    if (distinct.length > 1) {
      return unsupported(
        `Cannot resolve the collation conflict between '${distinct[0]}' and '${distinct[1]}'.`)
    }
    return distinct[0] ?? Collation.default_
  }

/** Distinct set operators over canonical keys while returning original representative values. */
const collatedUnion =
  (ctx: Context.t, select_: Ast.Select): string | undefined => {
    const terms: Ast.Select[] = []
    const kinds: ('union' | 'unionAll' | 'except' | 'intersect')[] = []
    for (let term: Ast.Select | undefined = select_; term !== undefined; term = term.union?.select) {
      terms.push(term)
      if (term.union !== undefined) {
        kinds.push(term.union.kind)
      }
    }
    const union = kinds.length > 0 && kinds.every(kind => kind === 'union')
    const pair = kinds.length === 1 && [ 'except', 'intersect' ].includes(kinds[0] ?? '')
    if ((!union && !pair) || terms.some(term => term.items.some(item => item.kind !== 'expression'))) {
      return undefined
    }
    const types = terms[0]?.items.map((_item, index) =>
      Implicit.commonTypes(terms.flatMap(term => Context.withSourceTypes(ctx, term.from, () => {
        const item = term.items[index]
        return item?.kind === 'expression' ? Implicit.typeOf(ctx, item.expression) ?? [] : []
      })))) ?? []
    if (!types.some(type => type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? ''))) {
      return undefined
    }
    const aliases = types.map((_type, index) => `__mssqlite_set_${index}`)
    const branches = terms.map(term => {
      const { union: _union, ctes: _ctes, orderBy: _orderBy, ...bare } = term
      return selectCore(ctx, {
        ...bare,
        items: term.items.map((item, index) => item.kind === 'expression' ?
          { ...item, alias: aliases[index] ?? `__mssqlite_set_${index}` } : item)
      })
    })
    const projected = aliases.map((alias, index) => {
      const item = terms[0]?.items[index]
      const name = item === undefined ? `column${index + 1}` : setProjectionName(item, index)
      return `${Quote.identifier(alias)} AS ${Quote.identifier(name)}`
    })
    const keys = aliases.map((alias, index) => {
      const rendered = Quote.identifier(alias)
      const type = types[index]
      return type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '') ?
        Collation.expressionKey(rendered, collationSet(ctx, terms, index)) : rendered
    })
    if (pair) {
      const left = aliases.map(alias => `${Quote.identifier('left_')}.${Quote.identifier(alias)}`)
      const right = aliases.map(alias => `${Quote.identifier('right_')}.${Quote.identifier(alias)}`)
      const comparisons = aliases.map((_alias, index) => {
        const type = types[index]
        const a = type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '') ?
          Collation.expressionKey(left[index] ?? 'NULL', collationSet(ctx, terms, index)) : left[index] ?? 'NULL'
        const b = type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '') ?
          Collation.expressionKey(right[index] ?? 'NULL', collationSet(ctx, terms, index)) : right[index] ?? 'NULL'
        return `((${a} = ${b}) OR (${a} IS NULL AND ${b} IS NULL))`
      })
      const exists = kinds[0] === 'except' ? 'NOT EXISTS' : 'EXISTS'
      const selected = left.map((value, index) => `${value} AS ${Quote.identifier(
        setProjectionName(terms[0]?.items[index] ?? { kind: 'star' }, index))}`)
      const grouped = keys.map((_key, index) => {
        const type = types[index]
        const value = left[index] ?? 'NULL'
        return type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '') ?
          Collation.expressionKey(value, collationSet(ctx, terms, index)) : value
      })
      return `SELECT ${selected.join(', ')} FROM (${branches[0]}) AS ${Quote.identifier('left_')} ` +
        `WHERE ${exists} (SELECT 1 FROM (${branches[1]}) AS ${Quote.identifier('right_')} ` +
        `WHERE ${comparisons.join(' AND ')}) GROUP BY ${grouped.join(', ')}`
    }
    return `SELECT ${projected.join(', ')} FROM (${branches.join(' UNION ALL ')}) ` +
      `GROUP BY ${keys.join(', ')}`
  }

const renderedSet =
  (ctx: Context.t, select_: Ast.Select): { readonly sql: string, readonly collated: boolean } => {
    const collated = collatedUnion(ctx, select_)
    if (collated !== undefined) {
      return { sql: collated, collated: true }
    }
    const parts = [ setTerm(ctx, select_) ]
    for (let union = select_.union; union !== undefined; union = union.select.union) {
      const keyword = {
        union: 'UNION',
        unionAll: 'UNION ALL',
        except: 'EXCEPT',
        intersect: 'INTERSECT'
      }[union.kind]
      parts.push(keyword, setTerm(ctx, union.select))
    }
    return { sql: parts.join(' '), collated: false }
  }

/** @returns SQLite SELECT — CTEs, set operations, TOP/OFFSET/FETCH become LIMIT. */
export const select =
  (ctx: Context.t, select_: Ast.Select): string => Context.withColumnExpressions(
    ctx,
    TableFunction.applyColumnExpressions(select_.from),
    () => {
      if (select_.forJson !== undefined) {
        return ForJson.select(ctx, select_, select)
      }
      if (Grouping.requiresExpansion(select_)) {
        return groupingSelect(ctx, select_)
      }
      const current = select_.union === undefined ? select_ : coercedSet(ctx, select_)
      const parts: string[] = []
      if (current.ctes !== undefined) {
        parts.push(`WITH ${cteDefinitions(ctx, current.ctes).join(', ')}`)
      }
      const inSet = current.union !== undefined
      const set = inSet ? renderedSet(ctx, current) : undefined
      parts.push(set?.sql ?? selectCore(ctx, current))
      if (current.orderBy !== undefined) {
        parts.push(orderBy(ctx, current.orderBy, inSet && set?.collated !== true ? undefined : current))
      }
      if (current.offset !== undefined) {
        const fetch = current.fetch === undefined ? '-1' : expression(ctx, current.fetch)
        parts.push(`LIMIT ${fetch} OFFSET ${expression(ctx, current.offset)}`)
      } else if (current.top !== undefined && !inSet) {
        parts.push(`LIMIT ${topLimit(ctx, current)}`)
      }
      return parts.join(' ')
    })

useSelectRender(select)

const insert =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'insert' }): string => {
    const table = Quote.objectName(statement_.table)
    const columns = statement_.columns === undefined ?
      '' :
      ` (${statement_.columns.map(Quote.identifier).join(', ')})`
    const returning = statement_.output === undefined ?
      '' :
      Output.returning(ctx, statement_.output, 'inserted', 'INSERT')
    switch (statement_.source.kind) {
      case 'defaultValues':
        return `INSERT INTO ${table}${columns} DEFAULT VALUES${returning}`
      case 'select':
        return `INSERT INTO ${table}${columns} ${select(ctx, statement_.source.select)}${returning}`
      case 'values': {
        const rows = statement_.source.rows
          .map(row =>
            `(${row.map(value =>
              value.kind === 'default' ?
                unsupported('DEFAULT in VALUES is not supported.') :
                expression(ctx, value)).join(', ')})`)
          .join(', ')
        return `INSERT INTO ${table}${columns} VALUES ${rows}${returning}`
      }
      default:
        return unsupported('Unsupported INSERT source.')
    }
  }

const targetTypeSource =
  (target: Ast.QualifiedName, columns: readonly Ast.SourceColumn[] | undefined): Ast.TableSource => ({
    kind: 'table', name: target,
    ...columns === undefined ? {} : { columns }
  })

const updateCore =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'update' }): string => {
    if (statement_.top !== undefined && statement_.from !== undefined) {
      return unsupported('UPDATE TOP with a FROM clause is not supported.')
    }
    // Pre-update values are not observable through RETURNING — the engine
    // snapshots the affected rows and never reaches this rendering.
    const returning = statement_.output === undefined ?
      '' :
      Output.readsDeleted(statement_.output) ?
        unsupported('UPDATE OUTPUT reading DELETED values has no direct SQLite rendering.') :
        Output.returning(ctx, statement_.output, 'inserted', 'UPDATE')
    const assignments = statement_.set
      .map(({ target, operator, value }) => {
        if (target.kind === 'variable') {
          return unsupported('Variable assignment in UPDATE is not supported.')
        }
        const column = Quote.identifier(target.name[target.name.length - 1] ?? '')
        if (operator === '=') {
          return `${column} = ${expression(ctx, value)}`
        }
        // Compound operators reuse binaryOp rendering so += concatenates text,
        // ^= rewrites to xor, etc. — never raw SQLite operators.
        const compound: Ast.Expression = {
          kind: 'binaryOp',
          operator: operator.slice(0, -1),
          left: { kind: 'column', name: target.name },
          right: value
        }
        return `${column} = ${expression(ctx, compound)}`
      })
      .join(', ')
    const target = Quote.objectName(statement_.target)
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    if (statement_.top !== undefined) {
      // MSSQL updates an arbitrary n rows — pick them by rowid.
      return `UPDATE ${target} SET ${assignments} WHERE rowid IN ` +
        `(SELECT rowid FROM ${target}${where} LIMIT ${expression(ctx, statement_.top)})${returning}`
    }
    const from = statement_.from === undefined ?
      '' :
      ` FROM ${tableSource(ctx, statement_.from)}`
    return `UPDATE ${target} SET ${assignments}${from}${where}${returning}`
  }

const update =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'update' }): string =>
    Context.withSourceTypes(ctx, targetTypeSource(statement_.target, statement_.targetColumns),
      () => updateCore(ctx, statement_))

/** @returns the plain-table leaves of a join tree. */
const tableLeaves =
  (source: Ast.TableSource): readonly (Ast.TableSource & { kind: 'table' })[] =>
    source.kind === 'table' ?
      [ source ] :
      source.kind === 'join' ?
        [ ...tableLeaves(source.left), ...tableLeaves(source.right) ] :
        []

const deleteCore =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'delete' }): string => {
    if (statement_.top !== undefined && statement_.from !== undefined) {
      return unsupported('DELETE TOP with a second FROM clause is not supported.')
    }
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    const returning = statement_.output === undefined ?
      '' :
      Output.returning(ctx, statement_.output, 'deleted', 'DELETE')
    if (statement_.from !== undefined) {
      // DELETE alias FROM t AS alias JOIN ... — the target names a table or
      // alias inside the FROM join tree; delete its rows by rowid membership.
      const targetName = (statement_.target[statement_.target.length - 1] ?? '').toLowerCase()
      const match = tableLeaves(statement_.from).find(leaf =>
        (leaf.alias ?? leaf.name[leaf.name.length - 1] ?? '').toLowerCase() === targetName)
      if (match === undefined) {
        return unsupported(`DELETE target ${targetName} is not in the FROM clause.`)
      }
      const qualifier = Quote.identifier(match.alias ?? (match.name[match.name.length - 1] ?? ''))
      return `DELETE FROM ${Quote.objectName(match.name)} WHERE rowid IN ` +
        `(SELECT ${qualifier}.rowid FROM ${tableSource(ctx, statement_.from)}${where})${returning}`
    }
    const target = Quote.objectName(statement_.target)
    if (statement_.top !== undefined) {
      // MSSQL deletes an arbitrary n rows — pick them by rowid.
      return `DELETE FROM ${target} WHERE rowid IN ` +
        `(SELECT rowid FROM ${target}${where} LIMIT ${expression(ctx, statement_.top)})${returning}`
    }
    return `DELETE FROM ${target}${where}${returning}`
  }

const delete_ =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'delete' }): string =>
    Context.withSourceTypes(ctx, targetTypeSource(statement_.target, statement_.targetColumns),
      () => deleteCore(ctx, statement_))

const referentialAction =
  (action: Ast.ReferentialAction): string =>
    ({
      noAction: 'NO ACTION',
      cascade: 'CASCADE',
      setNull: 'SET NULL',
      setDefault: 'SET DEFAULT'
    })[action]

const textType =
  (type: TypeName.t | undefined): boolean =>
    type !== undefined && [ 'text', 'ntext' ].includes(Type.category(type) ?? '')

const referencesClause =
  (references: NonNullable<Ast.ColumnDefinition['references']>): string => {
    const columns = references.columns === undefined ?
      '' :
      ` (${references.columns.map(Quote.identifier).join(', ')})`
    const onDelete = references.onDelete === undefined ?
      '' :
      ` ON DELETE ${referentialAction(references.onDelete)}`
    const onUpdate = references.onUpdate === undefined ?
      '' :
      ` ON UPDATE ${referentialAction(references.onUpdate)}`
    return `REFERENCES ${Quote.objectName(references.table)}${columns}${onDelete}${onUpdate}`
  }

const columnDefinition =
  (
    ctx: Context.t,
    column: Ast.ColumnDefinition,
    sourceColumns: readonly Ast.SourceColumn[] = []
  ): string => {
    const parts: string[] = [ Quote.identifier(column.name) ]
    const rowversion = column.type.name === 'rowversion' || column.type.name === 'timestamp'
    if (column.computed !== undefined) {
      const type = Type.columnType(column.type, column.collate)
      if (type !== '') {
        parts.push(type)
      }
      const source: Ast.TableSource = {
        kind: 'table', name: [ '__computed_source' ], columns: sourceColumns
      }
      const generated = Context.withSourceTypes(ctx, source, () =>
        Context.withGenerated(ctx, () => expression(ctx, column.computed?.expression ?? { kind: 'null' })))
      const converted = Character.family(column.type) === undefined ?
        generated : Character.cast(generated, column.type, false, 1)
      parts.push(`GENERATED ALWAYS AS (${converted}) ${column.computed.persisted ? 'STORED' : 'VIRTUAL'}`)
      if (column.nullable === false) {
        parts.push('NOT NULL')
      }
      return parts.join(' ')
    }
    const type = Type.columnType(column.type, column.collate)
    if (type !== '') {
      parts.push(type)
    }
    if (column.primaryKey === true) {
      parts.push('PRIMARY KEY')
    }
    // SQLite triggers populate rowversion after INSERT, so the physical BLOB
    // must accept the transient NULL even when catalog metadata is NOT NULL.
    if ((column.nullable === false || column.identity !== undefined) && !rowversion) {
      parts.push('NOT NULL')
    }
    if (column.unique === true) {
      parts.push('UNIQUE')
    }
    if (column.default_ !== undefined) {
      const default_ = column.default_
      const signed = default_.kind === 'unary' && [ '+', '-' ].includes(default_.operator) &&
        default_.operand.kind === 'number' ? `${default_.operator}${default_.operand.value}` : undefined
      const temporal = [ 'date', 'time', 'datetime' ].includes(Type.category(column.type) ?? '')
      const rendered_ = column.type.name === 'datetimeoffset' || temporal ?
        expression(ctx, { kind: 'cast', expression: default_, type: column.type, try_: false }) :
        Type.category(column.type) === 'decimal' && default_.kind === 'number' ?
          Quote.string(default_.value) : Type.category(column.type) === 'decimal' && signed !== undefined ?
            Quote.string(signed) : expression(ctx, default_)
      const rendered = Character.family(column.type) === undefined ?
        rendered_ : Character.store(rendered_, column.type, column.name)
      parts.push(`DEFAULT (${rendered})`)
    }
    if (column.check !== undefined) {
      parts.push(`CHECK (${expression(ctx, column.check)})`)
    }
    if (column.references !== undefined && !textType(column.type)) {
      parts.push(referencesClause(column.references))
    }
    return parts.join(' ')
  }

const tableConstraint =
  (
    ctx: Context.t,
    constraint: Ast.TableConstraint,
    columns: ReadonlyMap<string, Ast.ColumnDefinition>
  ): string | undefined => {
    const name = constraint.name === undefined ?
      '' :
      `CONSTRAINT ${Quote.identifier(constraint.name)} `
    switch (constraint.kind) {
      case 'primaryKey': {
        return `${name}PRIMARY KEY (${constraint.columns
          .map(column => `${Quote.identifier(column.name)}${column.descending ? ' DESC' : ''}`)
          .join(', ')})`
      }
      case 'unique':
        return `${name}UNIQUE (${constraint.columns
          .map(column => `${Quote.identifier(column.name)}${column.descending ? ' DESC' : ''}`)
          .join(', ')})`
      case 'foreignKey':
        if (constraint.columns.some(column => textType(columns.get(column.toLowerCase())?.type))) {
          return undefined
        }
        return `${name}FOREIGN KEY (${constraint.columns.map(Quote.identifier).join(', ')}) ${referencesClause(constraint.references)}`
      case 'check':
        return `${name}CHECK (${expression(ctx, constraint.expression)})`
      default:
        return unsupported('Unsupported table constraint.')
    }
  }

const nullSafeKey =
  (value: string, descending = false): readonly string[] => {
    const order = descending ? ' DESC' : ''
    return [ `(${value} IS NULL)${order}`, `ifnull(${value}, 0)${order}` ]
  }

const indexKey =
  (rendered: string, type: TypeName.t | undefined, collation: string | undefined): string =>
    collation !== undefined ||
    textType(type) ?
      Collation.expressionKey(rendered, collation ?? Collation.default_) :
      type?.name === 'datetimeoffset' ? DateTimeOffset.key(rendered) : rendered

const createTable =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'createTable' }): string => {
    const byName = new Map(statement_.columns.map(column => [ column.name.toLowerCase(), column ]))
    const members = [
      ...statement_.columns.map(column => columnDefinition(
        ctx,
        column,
        statement_.columns.map(candidate => ({
          name: candidate.name,
          type: candidate.type,
          nullable: candidate.nullable !== false,
          ...candidate.collate === undefined ? {} : { collation: candidate.collate }
        }))
      )),
      ...statement_.constraints
        .flatMap(constraint => tableConstraint(ctx, constraint, byName) ?? [])
    ]
    const table = Quote.objectName(statement_.name)
    const uniqueColumns: readonly (readonly { readonly name: string, readonly descending?: boolean }[])[] = [
      ...statement_.columns.filter(column => column.unique === true).map(column => [ column ]),
      ...statement_.constraints.filter(constraint => constraint.kind === 'unique')
        .map(constraint => constraint.kind === 'unique' ? constraint.columns : [])
    ]
    const uniqueIndexes = uniqueColumns.map((columns, index) => {
      const keys = columns.flatMap(column => {
        const definition = byName.get(column.name.toLowerCase())
        const rendered = Quote.identifier(column.name)
        const value = indexKey(rendered, definition?.type, definition?.collate)
        return nullSafeKey(value, column.descending)
      })
      const tableName = statement_.name[statement_.name.length - 1] ?? 'table'
      const target = Quote.indexTarget(`__mssqlite_${tableName}_unique_${index}`, statement_.name)
      return `CREATE UNIQUE INDEX ${target.index} ON ${target.table} (${keys.join(', ')})`
    })
    const primaryColumns = statement_.constraints.filter(constraint => constraint.kind === 'primaryKey')
      .flatMap(constraint => constraint.kind === 'primaryKey' ? [ constraint.columns ] : [])
    const primaryIndexes = primaryColumns.flatMap((columns, index) => {
      const definitions = columns.map(column => byName.get(column.name.toLowerCase()))
      if (!definitions.some(column => column !== undefined &&
        ([ 'text', 'ntext' ].includes(Type.category(column.type) ?? '') ||
          column.type.name === 'datetimeoffset'))) {
        return []
      }
      const keys = columns.map(column => {
        const definition = byName.get(column.name.toLowerCase())
        const rendered = Quote.identifier(column.name)
        return indexKey(rendered, definition?.type, definition?.collate)
      })
      const tableName = statement_.name[statement_.name.length - 1] ?? 'table'
      const target = Quote.indexTarget(`__mssqlite_${tableName}_collation_${index}`, statement_.name)
      return [ `CREATE UNIQUE INDEX ${target.index} ON ${target.table} (${keys.join(', ')})` ]
    })
    return [ `CREATE TABLE ${table} (${members.join(', ')})`, ...uniqueIndexes, ...primaryIndexes ].join('; ')
  }

const createIndex =
  (ctx: Context.t, statement_: Ast.Statement & { kind: 'createIndex' }): string => {
    const unique = statement_.unique ? 'UNIQUE ' : ''
    const target = Quote.indexTarget(statement_.name, statement_.table)
    const columns = statement_.columns
      .flatMap(column => {
        const value = Quote.identifier(column.name)
        const key = indexKey(value, column.type, column.collation)
        return statement_.unique ?
          nullSafeKey(key, column.descending) :
          [ `${key}${column.descending ? ' DESC' : ''}` ]
      })
      .join(', ')
    const where = statement_.where === undefined ?
      '' :
      ` WHERE ${expression(ctx, statement_.where)}`
    // INCLUDE columns have no SQLite equivalent — indexes still work, so drop them.
    return `CREATE ${unique}INDEX ${target.index} ON ${target.table} (${columns})${where}`
  }

/** Rendered statement with the variables it binds. */
export type Rendered = {
  readonly sql: string,
  readonly variables: readonly string[],
  readonly columns?: readonly ColumnHint[]
}

/**
 * @returns SQLite SQL of a directly renderable statement — SELECT, INSERT,
 * UPDATE, DELETE, TRUNCATE, DDL. Control flow, DECLARE/SET, transactions and
 * EXEC are interpreted by the engine instead.
 */
export const statement =
  (statement_: Ast.Statement): Rendered => {
    const ctx = Context.of()
    const sql = (() => {
      switch (statement_.kind) {
        case 'select':
          return select(ctx, statement_)
        case 'insert':
          return insert(ctx, statement_)
        case 'update':
          return update(ctx, statement_)
        case 'delete':
          return delete_(ctx, statement_)
        case 'truncate':
          return `DELETE FROM ${Quote.objectName(statement_.table)}`
        case 'createTable':
          return createTable(ctx, statement_)
        case 'createIndex':
          return createIndex(ctx, statement_)
        case 'createView': {
          const columns = statement_.columns === undefined ?
            '' :
            ` (${statement_.columns.map(Quote.identifier).join(', ')})`
          return `CREATE VIEW ${Quote.objectName(statement_.name)}${columns} AS ${select(ctx, statement_.select)}`
        }
        case 'dropTable':
          return statement_.names
            .map(name => `DROP TABLE ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.objectName(name)}`)
            .join('; ')
        case 'dropView':
          return statement_.names
            .map(name => `DROP VIEW ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.objectName(name)}`)
            .join('; ')
        case 'dropIndex':
          return `DROP INDEX ${statement_.ifExists ? 'IF EXISTS ' : ''}${Quote.identifier(statement_.name)}`
        case 'alterTable': {
          const table = Quote.objectName(statement_.name)
          switch (statement_.action.kind) {
            case 'addColumns':
              return statement_.action.columns
                .map(column => `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(ctx, column)}`)
                .join('; ')
            case 'dropColumns':
              return statement_.action.columns
                .map(column => `ALTER TABLE ${table} DROP COLUMN ${Quote.identifier(column)}`)
                .join('; ')
            default:
              return unsupported('ALTER TABLE constraints are not supported by SQLite.')
          }
        }
        default:
          return unsupported(`Statement ${statement_.kind} has no direct SQLite rendering.`)
      }
    })()
    const columns = statement_.kind === 'select' ?
      ForJson.selectHints(statement_) ?? TableFunction.selectHints(statement_) ??
        TableTransform.selectHints(statement_) ??
        Grouping.selectHints(statement_) ?? Implicit.projectionHints(statement_) ??
        Character.selectHints(statement_) ??
        DateTimeOffset.selectHints(statement_) ??
        Decimal.selectHints(statement_) ?? Implicit.selectHints(statement_) :
      undefined
    return {
      sql,
      variables: ctx.variables,
      ...columns === undefined ? {} : { columns }
    }
  }

/** @returns rendered scalar expression with its variables. */
export const scalar =
  (expression_: Ast.Expression): Rendered => {
    const ctx = Context.of()
    const sql = expression(ctx, expression_)
    return { sql, variables: ctx.variables }
  }

export default statement
