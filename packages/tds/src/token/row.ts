import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'
import * as Value from '../value.ts'
import type { Column } from './col-metadata.ts'

/** @returns ROW token bytes — one TYPE_VARBYTE value per column. */
export const row =
  (columns: readonly Column[], values: readonly Value.t[]): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.row),
      ...columns.map((column, index) =>
        Value.encode(column.typeInfo, values[index] ?? null))
    )

export default row
