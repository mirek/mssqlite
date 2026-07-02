import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'
import * as TypeInfo from '../type-info.ts'

/** Column flags. */
export const Flags = {
  nullable: 0x0001,
  caseSensitive: 0x0002,
  updateableReadWrite: 0x0004,
  updateableUnknown: 0x0008,
  identity: 0x0010,
  computed: 0x0020,
  hidden: 0x2000,
  key: 0x4000
} as const

/** Result set column. */
export type Column = {
  readonly name: string,
  readonly typeInfo: TypeInfo.t,
  readonly userType?: number,
  readonly flags?: number
}

/** @returns column flags with nullable set by default. */
export const flags =
  ({ nullable = true, identity = false, updateable = true }: {
    nullable?: boolean,
    identity?: boolean,
    updateable?: boolean
  } = {}): number =>
    (nullable ? Flags.nullable : 0) |
    (identity ? Flags.identity : 0) |
    (updateable ? Flags.updateableReadWrite : Flags.updateableUnknown)

/** @returns COLMETADATA token bytes for the columns of a result set. */
export const colMetadata =
  (columns: readonly Column[]): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.colMetadata),
      Encode.uint16(columns.length),
      ...columns.map(column =>
        Encode.concat(
          Encode.uint32(column.userType ?? 0),
          Encode.uint16(column.flags ?? flags()),
          TypeInfo.encode(column.typeInfo),
          Encode.bVarchar(column.name)
        ))
    )
