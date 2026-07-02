import { Decode, Encode, type Cursor, type Read, type Result } from '@mssqlite/bytes'

/** SQL collation — 5 bytes on the wire. */
export type Collation = {
  readonly lcid: number,
  readonly flags: number,
  readonly version: number,
  readonly sortId: number
}

export type t =
  Collation

/**
 * Default collation — SQL_Latin1_General_CP1_CI_AS
 * (lcid 0x0409, ignore case/kana/width, sort id 52), `09 04 D0 00 34` on the wire.
 */
export const default_: Collation = {
  lcid: 0x0409,
  flags: 0x0d,
  version: 0,
  sortId: 52
}

/** @returns 5 collation bytes — 20-bit lcid, 8-bit flags, 4-bit version, sort id. */
export const encode =
  (collation: Collation): Uint8Array => {
    const info = (collation.lcid & 0xfffff) |
      ((collation.flags & 0xff) << 20) |
      ((collation.version & 0x0f) << 28)
    return Encode.concat(
      Encode.uint32(info >>> 0),
      Encode.uint8(collation.sortId)
    )
  }

/** Collation decoder — 5 bytes. */
export const decode: Read.t<Collation> =
  (cursor: Cursor.t): Result.t<Collation> =>
    Decode.map(
      Decode.seq(Decode.uint32, Decode.uint8),
      ([ info, sortId ]) => ({
        lcid: info & 0xfffff,
        flags: (info >>> 20) & 0xff,
        version: (info >>> 28) & 0x0f,
        sortId
      })
    )(cursor)
