/** SQL type name with optional arguments, e.g. `nvarchar(50)`, `decimal(10, 2)`, `varchar(max)`. */
export type TypeName = {
  /** Lowercased type name; multi-part names collapse to the last part (`sys.int` → `int`). */
  readonly name: string,
  readonly args: readonly (number | 'max')[]
}

export type t =
  TypeName

/** @returns type name with no arguments. */
export const of =
  (name: string, args: readonly (number | 'max')[] = []): TypeName =>
    ({ name: name.toLowerCase(), args })
