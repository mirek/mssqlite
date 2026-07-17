import * as Context from './context.ts'
import * as Implicit from './implicit.ts'
import * as Quote from './quote.ts'
import * as TableTransform from './table-transform.ts'
import * as Type from './type.ts'
import { unsupported } from './error.ts'
import type { Ast } from '@mssqlite/tsql'
import type { ColumnHint } from './table-function.ts'

export const columnName = 'XML_F52E2B61-18A1-11d1-B105-00805F49916B'

type RenderSelect =
  (ctx: Context.t, select: Ast.Select) => string

type Descriptor = {
  readonly alias: string | null,
  readonly expression: Ast.Expression,
  readonly projected: string,
  readonly xml: boolean,
  readonly binary: boolean
}

type SourceColumn = {
  readonly name: string,
  readonly qualifier: string
}

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

const sourceColumns =
  (source: Ast.TableSource): readonly SourceColumn[] | undefined => {
    if (source.kind === 'join') {
      const left = sourceColumns(source.left)
      const right = sourceColumns(source.right)
      return left === undefined || right === undefined ? undefined : [ ...left, ...right ]
    }
    const alias = sourceAlias(source)
    const columns = source.kind === 'table' || source.kind === 'derived' ?
      source.columns?.map(column => column.name) :
      source.kind === 'values' ? source.columnMetadata?.map(column => column.name) :
        TableTransform.columns(source)
    return alias === undefined || columns === undefined ? undefined :
      columns.map(name => ({ name, qualifier: alias }))
  }

const isXml =
  (expression: Ast.Expression): boolean =>
    (expression.kind === 'subquery' && expression.select.forXml?.type === true) ||
    ((expression.kind === 'cast' || expression.kind === 'convert') && expression.type.name === 'xml')

const descriptor =
  (
    ctx: Context.t,
    expression: Ast.Expression,
    alias: string | null,
    index: number
  ): Descriptor => ({
    alias,
    expression,
    projected: `__mssqlite_xml_${index}`,
    xml: isXml(expression),
    binary: Type.category(Implicit.typeOf(ctx, expression) ?? { name: '', args: [] }) === 'blob'
  })

const starDescriptors =
  (
    ctx: Context.t,
    item: Ast.SelectItem & { kind: 'star' },
    columns: readonly SourceColumn[] | undefined,
    start: number
  ): readonly Descriptor[] => {
    if (columns === undefined) {
      return unsupported('FOR XML star projection requires statically known source columns.')
    }
    const qualifier = item.qualifier?.[item.qualifier.length - 1]?.toLowerCase()
    return columns.filter(candidate =>
      qualifier === undefined || candidate.qualifier.toLowerCase() === qualifier)
      .map((column, index) => descriptor(ctx,
        { kind: 'column', name: [ column.qualifier, column.name ] },
        column.name, start + index))
  }

const descriptors =
  (ctx: Context.t, select: Ast.Select): readonly Descriptor[] => {
    const columns = select.from === undefined ? undefined : sourceColumns(select.from)
    const result: Descriptor[] = []
    for (const item of select.items) {
      if (item.kind === 'assign') {
        return unsupported('FOR XML does not support variable-assignment select items.')
      }
      if (item.kind === 'star') {
        result.push(...starDescriptors(ctx, item, columns, result.length))
        continue
      }
      const expression = item.expression
      const alias = item.alias ?? (expression.kind === 'column' ?
        expression.name[expression.name.length - 1] ?? null : null)
      result.push(descriptor(ctx, expression, alias, result.length))
    }
    return result
  }

const baseSelect =
  (select: Ast.Select, items: readonly Descriptor[]): Ast.Select => {
    const { forXml: _forXml, ...base } = select
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
        kind: 'expression', expression: item.expression, alias: item.projected
      })),
      ...orderBy === undefined ? {} : { orderBy }
    }
  }

const specification =
  (
    options: Ast.ForXml,
    items: readonly Descriptor[],
    namespaces: readonly Ast.XmlNamespace[]
  ): string =>
    JSON.stringify({
      mode: options.mode,
      rowName: options.rowName ?? 'row',
      ...options.root === undefined ? {} : { root: options.root },
      elements: options.elements,
      binaryBase64: options.binaryBase64,
      namespaces,
      descriptors: items.map(item => ({
        alias: item.alias,
        xml: item.xml,
        binary: item.binary
      }))
    })

/** @returns one-row SQLite XML rendering for supported PATH and RAW modes. */
export const select =
  (ctx: Context.t, select_: Ast.Select, render: RenderSelect): string => {
    const options = select_.forXml
    if (options === undefined) {
      return unsupported('Missing FOR XML options.')
    }
    if (options.unsupported !== undefined) {
      return unsupported(`FOR XML ${options.unsupported.toUpperCase()} is not supported.`)
    }
    if (options.mode === 'auto' || options.mode === 'explicit') {
      return unsupported(`FOR XML ${options.mode.toUpperCase()} is not supported.`)
    }
    const items = Context.withSourceTypes(ctx, select_.from, () => descriptors(ctx, select_))
    if (options.mode === 'raw' && items.some(item => item.alias === null)) {
      return unsupported('FOR XML RAW requires a name for every selected expression.')
    }
    const base = render(ctx, baseSelect(select_, items))
    const namespaces = select_.xmlNamespaces ?? []
    const spec = Quote.string(specification(options, items, namespaces))
    const values = items.map(item => Quote.identifier(item.projected))
    const row = `mssqlite_for_xml_row(${[ spec, ...values ].join(', ')})`
    const rows = `SELECT ${row} AS "__mssqlite_xml_row" FROM (${base}) AS "__mssqlite_xml_base"`
    const content = 'group_concat("__mssqlite_xml_row", \'\')'
    const root = options.root === undefined ? 'NULL' : Quote.string(options.root)
    return `SELECT mssqlite_for_xml_document(${content}, ${root}, ` +
      `${options.elements === 'xsinil' ? 1 : 0}, ${Quote.string(JSON.stringify(namespaces))}) ` +
      `AS ${Quote.identifier(
        options.type ? '' : columnName)} FROM (${rows}) AS "__mssqlite_xml_rows"`
  }

/** Exact FOR XML result metadata: XML with TYPE, nvarchar(max) otherwise. */
export const selectHints =
  (select_: Ast.Select): readonly ColumnHint[] | undefined =>
    select_.forXml === undefined ? undefined : [ {
      name: select_.forXml.type ? '' : columnName,
      type: select_.forXml.type ? { name: 'xml', args: [] } : { name: 'nvarchar', args: [ 'max' ] },
      nullable: true
    } ]
