import type { Ast, TypeName } from '@mssqlite/tsql'

/**
 * Mutable render context — accumulates the variables a statement references
 * so the engine can bind exactly those parameters.
 */
export type Context = {
  /** Lowercased variable tokens in order of first use, e.g. `@x`, `@@rowcount`. */
  readonly variables: string[]
  readonly columnTypes: ReadonlyMap<string, TypeName.t>[]
  generated: boolean
  nextSource: number
}

export type t =
  Context

/** @returns fresh render context. */
export const of =
  (): Context =>
    ({ variables: [], columnTypes: [], generated: false, nextSource: 1 })

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
    if (source.kind !== 'table' || source.columns === undefined) {
      return []
    }
    const qualifier = (source.alias ?? source.name[source.name.length - 1] ?? '').toLowerCase()
    return source.columns.flatMap(column => column.type === undefined ? [] : [
      { key: column.name.toLowerCase(), type: column.type },
      { key: `${qualifier}.${column.name.toLowerCase()}`, type: column.type }
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
    ctx.columnTypes.push(types)
    try {
      return run()
    } finally {
      ctx.columnTypes.pop()
    }
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
