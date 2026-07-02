import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** LOGINACK fields. */
export type LoginAck = {
  /** 0 = SQL_DFLT, 1 = SQL_TSQL. */
  readonly interface?: number,
  /** Server-to-client TDS version, e.g. 0x74000004 for TDS 7.4. */
  readonly tdsVersion: number,
  readonly progName: string,
  readonly version: { major: number, minor: number, buildHigh: number, buildLow: number }
}

/** Server-to-client TDS 7.4 version. */
export const tdsVersion74 = 0x74000004

/** @returns LOGINACK token bytes. */
export const loginAck =
  (ack: LoginAck): Uint8Array => {
    const payload = Encode.concat(
      Encode.uint8(ack.interface ?? 1),
      Encode.uint32be(ack.tdsVersion),
      Encode.bVarchar(ack.progName),
      Encode.uint8(ack.version.major),
      Encode.uint8(ack.version.minor),
      Encode.uint8(ack.version.buildHigh),
      Encode.uint8(ack.version.buildLow)
    )
    return Encode.concat(
      Encode.uint8(Token.loginAck),
      Encode.uint16(payload.byteLength),
      payload
    )
  }
