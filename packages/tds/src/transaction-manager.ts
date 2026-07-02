import { Cursor, Decode, Result, Ucs2 } from '@mssqlite/bytes'
import * as AllHeaders from './all-headers.ts'

/** Transaction manager request types. */
export const Type = {
  getDtcAddress: 0,
  propagateXact: 1,
  beginXact: 5,
  promoteXact: 6,
  commitXact: 7,
  rollbackXact: 8,
  saveXact: 9
} as const

/** Isolation levels. */
export const IsolationLevel = {
  current: 0x00,
  readUncommitted: 0x01,
  readCommitted: 0x02,
  repeatableRead: 0x03,
  serializable: 0x04,
  snapshot: 0x05
} as const

/** Decoded transaction manager request. */
export type TransactionManager = {
  readonly headers: AllHeaders.t,
  readonly type: number,
  readonly isolationLevel?: number,
  readonly name?: string
}

export type t =
  TransactionManager

/** @returns decoded transaction manager request from a full message payload. */
export const decode =
  (payload: Uint8Array): TransactionManager | undefined => {
    const headers = AllHeaders.decode(payload)
    if (headers === undefined) {
      return undefined
    }
    const type = Decode.uint16(Cursor.of(payload, headers.length))
    if (Result.failed(type)) {
      return undefined
    }
    switch (type.value) {
      case Type.beginXact: {
        const begin = Decode.seq(Decode.uint8, Decode.bVarbyte)(type.cursor)
        return Result.failed(begin) ?
          { headers, type: type.value } :
          {
            headers,
            type: type.value,
            isolationLevel: begin.value[0],
            name: Ucs2.decode(begin.value[1])
          }
      }
      case Type.commitXact:
      case Type.rollbackXact:
      case Type.saveXact: {
        const name = Decode.bVarbyte(type.cursor)
        return Result.failed(name) ?
          { headers, type: type.value } :
          { headers, type: type.value, name: Ucs2.decode(name.value) }
      }
      default:
        return { headers, type: type.value }
    }
  }
