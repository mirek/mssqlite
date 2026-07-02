import { Encode } from '@mssqlite/bytes'
import { Token } from '../token.ts'

/** DONE status flags. */
export const Status = {
  final: 0x0000,
  more: 0x0001,
  error: 0x0002,
  inXact: 0x0004,
  count: 0x0010,
  attention: 0x0020,
  rpcInBatch: 0x0080,
  serverError: 0x0100
} as const

const encodeAny =
  (token: number) =>
    (status: number, currentCommand = 0, rowCount: bigint | number = 0n): Uint8Array =>
      Encode.concat(
        Encode.uint8(token),
        Encode.uint16(status),
        Encode.uint16(currentCommand),
        Encode.uint64(rowCount)
      )

/** @returns DONE token bytes. */
export const done =
  encodeAny(Token.done)

/** @returns DONEPROC token bytes. */
export const doneProc =
  encodeAny(Token.doneProc)

/** @returns DONEINPROC token bytes. */
export const doneInProc =
  encodeAny(Token.doneInProc)
