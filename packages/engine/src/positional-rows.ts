import type { Value } from './session.ts'
import type { StatementSync } from 'node:sqlite'

type Bindings =
  Readonly<Record<string, null | number | bigint | string | Uint8Array>>

/** Executes a result statement as ordered arrays, preserving duplicate labels. */
export const positionalRows =
  (statement: StatementSync, bindings: Bindings): Value[][] => {
    statement.setReturnArrays(true)
    return statement.all(bindings) as unknown as Value[][]
  }

export default positionalRows
