import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** Server error or informational message. */
export type Message = {
  readonly number: number,
  readonly state: number,
  /** Severity class — 0-10 informational, 11-25 errors. */
  readonly class: number,
  readonly message: string,
  readonly serverName?: string,
  readonly procName?: string,
  readonly lineNumber?: number
}

const body =
  (token: number, message: Message): Uint8Array => {
    const payload = Encode.concat(
      Encode.int32(message.number),
      Encode.uint8(message.state),
      Encode.uint8(message.class),
      Encode.usVarchar(message.message),
      Encode.bVarchar(message.serverName ?? ''),
      Encode.bVarchar(message.procName ?? ''),
      Encode.int32(message.lineNumber ?? 1)
    )
    return Encode.concat(
      Encode.uint8(token),
      Encode.uint16(payload.byteLength),
      payload
    )
  }

/** @returns ERROR token bytes. */
export const error =
  (message: Message): Uint8Array =>
    body(Token.error, message)

/** @returns INFO token bytes. */
export const info =
  (message: Message): Uint8Array =>
    body(Token.info, message)
