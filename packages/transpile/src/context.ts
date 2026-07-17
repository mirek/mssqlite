import type { Ast, TypeName } from '@mssqlite/tsql'

/**
 * Mutable render context — accumulates the variables a statement references
 * so the engine can bind exactly those parameters.
 */
export type Context = {
  /** Lowercased variable tokens in order of first use, e.g. `@x`, `@@rowcount`. */
  readonly variables: string[]
  readonly columnTypes: ReadonlyMap<string, TypeName.t>[]
  readonly columnCollations: ReadonlyMap<string, string>[]
  readonly columnNullability: ReadonlyMap<string, boolean>[]
  readonly columnExpressions: ReadonlyMap<string, string>[]
  generated: boolean
  nextSource: number
}

export type t =
  Context

/** @returns fresh render context. */
export const of =
  (): Context =>
    ({
      variables: [], columnTypes: [], columnCollations: [], columnNullability: [], columnExpressions: [],
      generated: false, nextSource: 1
    })

/** Runs expression rendering in SQLite generated-column mode. */
export const withGenerated =
  <T>(ctx: Context, run: () => T): T => {
    const saved = ctx.generated
    ctx.generated = true
    try {
      return run()
    } finally {
      ctx.generated = saved
    }
  }

const sourceColumns =
  (source: Ast.TableSource): readonly { readonly key: string, readonly type: TypeName.t }[] => {
    if (source.kind === 'join') {
      return [ ...sourceColumns(source.left), ...sourceColumns(source.right) ]
    }
    if (source.kind !== 'table' && source.kind !== 'values' && source.kind !== 'derived') {
      return []
    }
    const metadata = source.kind === 'values' ? source.columnMetadata : source.columns
    if (metadata === undefined) {
      return []
    }
    const qualifier = (source.kind === 'table' ?
      (source.alias ?? source.name[source.name.length - 1] ?? '') : source.alias).toLowerCase()
    return metadata.flatMap(column => column.type === undefined ? [] : [
      { key: column.name.toLowerCase(), type: column.type },
      { key: `${qualifier}.${column.name.toLowerCase()}`, type: column.type }
    ])
  }

const sourceCollations =
  (source: Ast.TableSource): readonly { readonly key: string, readonly collation: string }[] => {
    if (source.kind === 'join') {
      return [ ...sourceCollations(source.left), ...sourceCollations(source.right) ]
    }
    if (source.kind !== 'table' && source.kind !== 'values' && source.kind !== 'derived') {
      return []
    }
    const metadata = source.kind === 'values' ? source.columnMetadata : source.columns
    if (metadata === undefined) {
      return []
    }
    const qualifier = (source.kind === 'table' ?
      (source.alias ?? source.name[source.name.length - 1] ?? '') : source.alias).toLowerCase()
    return metadata.flatMap(column => column.collation === undefined ? [] : [
      { key: column.name.toLowerCase(), collation: column.collation },
      { key: `${qualifier}.${column.name.toLowerCase()}`, collation: column.collation }
    ])
  }

const sourceNullability =
  (source: Ast.TableSource): readonly { readonly key: string, readonly nullable: boolean }[] => {
    if (source.kind === 'join') {
      return [ ...sourceNullability(source.left), ...sourceNullability(source.right) ]
    }
    if (source.kind !== 'table' && source.kind !== 'values' && source.kind !== 'derived') {
      return []
    }
    const metadata = source.kind === 'values' ? source.columnMetadata : source.columns
    if (metadata === undefined) {
      return []
    }
    const qualifier = (source.kind === 'table' ?
      (source.alias ?? source.name[source.name.length - 1] ?? '') : source.alias).toLowerCase()
    return metadata.flatMap(column => [
      { key: column.name.toLowerCase(), nullable: column.nullable !== false },
      { key: `${qualifier}.${column.name.toLowerCase()}`, nullable: column.nullable !== false }
    ])
  }

/** Runs a SELECT renderer with its source-column types in lexical scope. */
export const withSourceTypes =
  <T>(ctx: Context, source: Ast.TableSource | undefined, run: () => T): T => {
    const columns = source === undefined ? [] : sourceColumns(source)
    const counts = new Map<string, number>()
    columns.forEach(column => counts.set(column.key, (counts.get(column.key) ?? 0) + 1))
    const types = new Map(columns
      .filter(column => column.key.includes('.') || counts.get(column.key) === 1)
      .map(column => [ column.key, column.type ]))
    const collations = source === undefined ? [] : sourceCollations(source)
    const collationCounts = new Map<string, number>()
    collations.forEach(column =>
      collationCounts.set(column.key, (collationCounts.get(column.key) ?? 0) + 1))
    const scopedCollations = new Map(collations
      .filter(column => column.key.includes('.') || collationCounts.get(column.key) === 1)
      .map(column => [ column.key, column.collation ]))
    const nullability = source === undefined ? [] : sourceNullability(source)
    const nullabilityCounts = new Map<string, number>()
    nullability.forEach(column =>
      nullabilityCounts.set(column.key, (nullabilityCounts.get(column.key) ?? 0) + 1))
    const scopedNullability = new Map(nullability
      .filter(column => column.key.includes('.') || nullabilityCounts.get(column.key) === 1)
      .map(column => [ column.key, column.nullable ]))
    ctx.columnTypes.push(types)
    ctx.columnCollations.push(scopedCollations)
    ctx.columnNullability.push(scopedNullability)
    try {
      return run()
    } finally {
      ctx.columnTypes.pop()
      ctx.columnCollations.pop()
      ctx.columnNullability.pop()
    }
  }

/** @returns declared collation of a column in the innermost visible source. */
export const columnCollation =
  (ctx: Context, name: Ast.QualifiedName): string | undefined => {
    const key = name.slice(-2).map(part => part.toLowerCase()).join('.')
    for (let i = ctx.columnCollations.length - 1; i >= 0; i--) {
      const found = ctx.columnCollations[i]?.get(key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

/** @returns declared type of a column in the innermost visible SELECT source. */
export const columnType =
  (ctx: Context, name: Ast.QualifiedName): TypeName.t | undefined => {
    const key = name.slice(-2).map(part => part.toLowerCase()).join('.')
    for (let i = ctx.columnTypes.length - 1; i >= 0; i--) {
      const found = ctx.columnTypes[i]?.get(key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

/** @returns declared nullability of a column in the innermost visible source. */
export const columnNullable =
  (ctx: Context, name: Ast.QualifiedName): boolean | undefined => {
    const key = name.slice(-2).map(part => part.toLowerCase()).join('.')
    for (let i = ctx.columnNullability.length - 1; i >= 0; i--) {
      const found = ctx.columnNullability[i]?.get(key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

/** Runs a renderer with source-specific replacements for exposed columns. */
export const withColumnExpressions =
  <T>(ctx: Context, expressions: ReadonlyMap<string, string>, run: () => T): T => {
    ctx.columnExpressions.push(expressions)
    try {
      return run()
    } finally {
      ctx.columnExpressions.pop()
    }
  }

/** @returns a source-specific SQLite expression for an exposed column. */
export const columnExpression =
  (ctx: Context, name: Ast.QualifiedName): string | undefined => {
    const key = name.slice(-2).map(part => part.toLowerCase()).join('.')
    for (let index = ctx.columnExpressions.length - 1; index >= 0; index--) {
      const found = ctx.columnExpressions[index]?.get(key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }

/**
 * @returns SQLite parameter name of a T-SQL variable — `@x` stays `@x`,
 * globals map `@@rowcount` → `@__rowcount`. Records the variable in context.
 */
export const parameter =
  (ctx: Context, variable: string): string => {
    const name = variable.toLowerCase()
    if (!ctx.variables.includes(name)) {
      ctx.variables.push(name)
    }
    return name.startsWith('@@') ? `@__${name.slice(2)}` : name
  }
