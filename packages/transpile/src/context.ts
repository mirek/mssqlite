/**
 * Mutable render context — accumulates the variables a statement references
 * so the engine can bind exactly those parameters.
 */
export type Context = {
  /** Lowercased variable tokens in order of first use, e.g. `@x`, `@@rowcount`. */
  readonly variables: string[]
}

export type t =
  Context

/** @returns fresh render context. */
export const of =
  (): Context =>
    ({ variables: [] })

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
