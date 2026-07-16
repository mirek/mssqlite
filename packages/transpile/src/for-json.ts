import * as Quote from './quote.ts'
import * as TableTransform from './table-transform.ts'
import { unsupported } from './error.ts'
import type * as Context from './context.ts'
import type { Ast } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

export const columnName = 'JSON_F52E2B61-18A1-11d1-B105-00805F49916B'

type RenderSelect =
  (ctx: Context.t, select: Ast.Select) => string

type Descriptor = {
  readonly key: string,
  readonly expression: Ast.Expression,
  readonly alias: string,
  readonly qualifier?: string,
  readonly json: boolean
}

type SourceColumn = {
  readonly name: string,
  readonly qualifier: string
}

type Node = {
  readonly leaves: Map<string, Descriptor>,
  readonly children: Map<string, Node>,
  readonly order: { readonly kind: 'leaf' | 'child', readonly name: string }[]
}

const node =
  (): Node =>
    ({ leaves: new Map(), children: new Map(), order: [] })

const sourceAlias =
  (source: Ast.TableSource): string | undefined => {
    switch (source.kind) {
      case 'table':
      case 'function':
        return source.alias ?? source.name[source.name.length - 1]
      case 'derived':
      case 'pivot':
      case 'unpivot':
        return source.alias
      default:
        return undefined
    }
  }

const sourceColumns =
  (source: Ast.TableSource): readonly SourceColumn[] | undefined => {
    if (source.kind === 'join') {
      const left = sourceColumns(source.left)
      const right = sourceColumns(source.right)
      return left === undefined || right === undefined ? undefined : [ ...left, ...right ]
    }
    const alias = sourceAlias(source)
    const columns = source.kind === 'table' ?
      source.columns?.map(column => column.name) :
      TableTransform.columns(source)
    return alias === undefined || columns === undefined ? undefined :
      columns.map(name => ({ name, qualifier: alias }))
  }

const isJson =
  (expression: Ast.Expression): boolean =>
    (expression.kind === 'subquery' && expression.select.forJson !== undefined) ||
    (expression.kind === 'call' &&
      (expression.name[expression.name.length - 1] ?? '').toLowerCase() === 'json_query')

const descriptors =
  (select: Ast.Select): readonly Descriptor[] => {
    const columns = select.from === undefined ? undefined : sourceColumns(select.from)
    const result: Descriptor[] = []
    for (const item of select.items) {
      if (item.kind === 'assign') {
        return unsupported('FOR JSON does not support variable-assignment select items.')
      }
      if (item.kind === 'star') {
        if (columns === undefined) {
          return unsupported('FOR JSON star projection requires statically known source columns.')
        }
        const qualifier = item.qualifier?.[item.qualifier.length - 1]?.toLowerCase()
        for (const column of columns.filter(candidate =>
          qualifier === undefined || candidate.qualifier.toLowerCase() === qualifier)) {
          result.push({
            key: column.name,
            expression: { kind: 'column', name: [ column.qualifier, column.name ] },
            alias: `__mssqlite_json_${result.length}`,
            qualifier: column.qualifier,
            json: false
          })
        }
        continue
      }
      const expression_ = item.expression
      const key = item.alias ?? (expression_.kind === 'column' ?
        expression_.name[expression_.name.length - 1] : undefined)
      if (key === undefined) {
        return unsupported('FOR JSON requires a name or alias for every selected expression.')
      }
      const inferredQualifier = expression_.kind === 'column' && expression_.name.length === 1 ?
        columns?.filter(column => column.name.toLowerCase() ===
          expression_.name[0]?.toLowerCase()).map(column => column.qualifier) :
        undefined
      const qualifier = expression_.kind === 'column' && expression_.name.length > 1 ?
        expression_.name[expression_.name.length - 2] :
        inferredQualifier?.length === 1 ? inferredQualifier[0] : undefined
      result.push({
        key,
        expression: expression_,
        alias: `__mssqlite_json_${result.length}`,
        ...qualifier === undefined ? {} : { qualifier },
        json: isJson(expression_)
      })
    }
    return result
  }

const valueSql =
  (descriptor: Descriptor): string => {
    const value = Quote.identifier(descriptor.alias)
    return descriptor.json ? `json(${value})` : value
  }

const insertPath =
  (root: Node, path: readonly string[], descriptor: Descriptor): void => {
    if (path.length === 0 || path.some(part => part === '')) {
      unsupported(`Invalid FOR JSON PATH alias ${descriptor.key}.`)
    }
    let current = root
    for (const part of path.slice(0, -1)) {
      if (current.leaves.has(part)) {
        unsupported(`FOR JSON PATH alias ${descriptor.key} conflicts with another property.`)
      }
      let child = current.children.get(part)
      if (child === undefined) {
        child = node()
        current.children.set(part, child)
        current.order.push({ kind: 'child', name: part })
      }
      current = child
    }
    const leaf = path[path.length - 1] ?? ''
    if (current.leaves.has(leaf) || current.children.has(leaf)) {
      unsupported(`Duplicate FOR JSON property ${descriptor.key}.`)
    }
    current.leaves.set(leaf, descriptor)
    current.order.push({ kind: 'leaf', name: leaf })
  }

const directObject =
  (root: Node): string => {
    const entries = root.order.flatMap(entry => {
      const descriptor = root.leaves.get(entry.name)
      const child = root.children.get(entry.name)
      return entry.kind === 'leaf' && descriptor !== undefined ?
        [ Quote.string(entry.name), valueSql(descriptor) ] :
        child === undefined ? [] : [ Quote.string(entry.name), `json(${directObject(child)})` ]
    })
    return `json_object(${entries.join(', ')})`
  }

const omittedNullObject =
  (root: Node): string => {
    const fragments = root.order.map(entry => {
      const descriptor = root.leaves.get(entry.name)
      const child = root.children.get(entry.name)
      if (entry.kind === 'leaf' && descriptor !== undefined) {
        const value = valueSql(descriptor)
        return `json(CASE WHEN ${Quote.identifier(descriptor.alias)} IS NULL THEN '{}' ELSE ` +
          `json_object(${Quote.string(entry.name)}, ${value}) END)`
      }
      if (child !== undefined) {
        const value = omittedNullObject(child)
        return `json(CASE WHEN ${value} = '{}' THEN '{}' ELSE ` +
          `json_object(${Quote.string(entry.name)}, json(${value})) END)`
      }
      return 'json(\'{}\')'
    })
    return fragments.reduce((left, right) => `json_patch(${left}, ${right})`, 'json(\'{}\')')
  }

const objectSql =
  (items: readonly Descriptor[], nested: boolean, includeNullValues: boolean): string => {
    const root = node()
    for (const item of items) {
      insertPath(root, nested ? item.key.split('.') : [ item.key ], item)
    }
    return includeNullValues ? directObject(root) : omittedNullObject(root)
  }

const baseSelect =
  (select: Ast.Select, items: readonly Descriptor[]): Ast.Select => {
    const { forJson: _forJson, ...base } = select
    const orderBy = select.orderBy?.map(order => {
      if (order.expression.kind !== 'column' || order.expression.name.length !== 1) {
        return order
      }
      const name = order.expression.name[0]?.toLowerCase()
      const selected = select.items.find(item =>
        item.kind === 'expression' && item.alias?.toLowerCase() === name)
      return selected?.kind === 'expression' ? { ...order, expression: selected.expression } : order
    })
    return {
      ...base,
      items: items.map(item => ({
        kind: 'expression',
        expression: item.expression,
        alias: item.alias
      })),
      ...orderBy === undefined ? {} : { orderBy }
    }
  }

const aggregate =
  (rows: string, options: Ast.ForJson): string => {
    const array = options.withoutArrayWrapper ?
      'COALESCE(group_concat("__mssqlite_json_row", \',\'), \'\')' :
      'COALESCE(json_group_array(json("__mssqlite_json_row")), json(\'[]\'))'
    const output = options.root === undefined ?
      array :
      options.withoutArrayWrapper ?
        `CASE WHEN ${array} = '' THEN json_object(${Quote.string(options.root)}, json('[]')) ` +
          `ELSE json_object(${Quote.string(options.root)}, json(${array})) END` :
        `json_object(${Quote.string(options.root)}, json(${array}))`
    return `SELECT ${output} AS ${Quote.identifier(columnName)} FROM (${rows}) AS "__mssqlite_json_rows"`
  }

const path =
  (ctx: Context.t, select: Ast.Select, items: readonly Descriptor[], render: RenderSelect): string => {
    const base = render(ctx, baseSelect(select, items))
    const row = objectSql(items, true, select.forJson?.includeNullValues ?? false)
    return aggregate(`SELECT ${row} AS "__mssqlite_json_row" FROM (${base}) AS "__mssqlite_json_base"`,
      select.forJson ?? { mode: 'path', includeNullValues: false, withoutArrayWrapper: false })
  }

const auto =
  (ctx: Context.t, select: Ast.Select, items: readonly Descriptor[], render: RenderSelect): string => {
    if (select.from === undefined) {
      return unsupported('FOR JSON AUTO requires a FROM clause.')
    }
    const base = render(ctx, baseSelect(select, items))
    if (select.from.kind !== 'join') {
      const row = objectSql(items, false, select.forJson?.includeNullValues ?? false)
      return aggregate(
        `SELECT ${row} AS "__mssqlite_json_row" FROM (${base}) AS "__mssqlite_json_base"`,
        select.forJson ?? { mode: 'auto', includeNullValues: false, withoutArrayWrapper: false })
    }
    const rootAlias = sourceAlias(select.from.left)
    if (rootAlias === undefined) {
      return unsupported('FOR JSON AUTO requires a simple leftmost table source.')
    }
    const rootItems = items.filter(item => item.qualifier?.toLowerCase() === rootAlias.toLowerCase())
    const childAliases = [ ...new Set(items
      .filter(item => !rootItems.includes(item))
      .map(item => item.qualifier)) ]
    if (rootItems.length === 0 || childAliases.length !== 1 || childAliases[0] === undefined) {
      return unsupported('FOR JSON AUTO joins currently require projected columns from one root and one child alias.')
    }
    const childAlias = childAliases[0]
    const childItems = items.filter(item => item.qualifier?.toLowerCase() === childAlias.toLowerCase())
    const root = objectSql(rootItems, false, select.forJson?.includeNullValues ?? false)
    const child = objectSql(childItems, false, select.forJson?.includeNullValues ?? false)
    const present = childItems.map(item => `${Quote.identifier(item.alias)} IS NOT NULL`).join(' OR ')
    const childProperty = `CASE WHEN max(CASE WHEN ${present} THEN 1 ELSE 0 END) = 0 THEN json('{}') ` +
      `ELSE json_object(${Quote.string(childAlias)}, ` +
      `json_group_array(json(${child})) FILTER (WHERE ${present})) END`
    const row = `json_patch(${root}, ${childProperty})`
    const grouped = `SELECT ${row} AS "__mssqlite_json_row" FROM (${base}) AS "__mssqlite_json_base" ` +
      `GROUP BY ${rootItems.map(item => Quote.identifier(item.alias)).join(', ')}`
    return aggregate(grouped,
      select.forJson ?? { mode: 'auto', includeNullValues: false, withoutArrayWrapper: false })
  }

/** @returns one-row SQLite JSON rendering. */
export const select =
  (ctx: Context.t, select_: Ast.Select, render: RenderSelect): string => {
    const options = select_.forJson
    if (options === undefined) {
      return unsupported('Missing FOR JSON options.')
    }
    const items = descriptors(select_)
    return options.mode === 'path' ? path(ctx, select_, items, render) : auto(ctx, select_, items, render)
  }

/** Exact SQL Server FOR JSON result-column metadata. */
export const selectHints =
  (select_: Ast.Select): readonly ColumnHint[] | undefined =>
    select_.forJson === undefined ? undefined : [ {
      name: columnName,
      type: { name: 'nvarchar', args: [ 'max' ] },
      nullable: false
    } ]
