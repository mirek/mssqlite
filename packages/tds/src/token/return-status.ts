import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** @returns RETURNSTATUS token bytes — signed 32-bit return code of an RPC. */
export const returnStatus =
  (value: number): Uint8Array =>
    Encode.concat(
      Encode.uint8(Token.returnStatus),
      Encode.int32(value)
    )

export default returnStatus
