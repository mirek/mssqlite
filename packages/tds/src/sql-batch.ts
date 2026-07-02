import { Encode, Ucs2 } from '@mssqlite/bytes'
import * as AllHeaders from './all-headers.ts'

/** Decoded SQL batch request. */
export type SqlBatch = {
  readonly headers: AllHeaders.t,
  readonly sql: string
}

export type t =
  SqlBatch

/** @returns decoded SQL batch from a full message payload. */
export const decode =
  (payload: Uint8Array): SqlBatch | undefined => {
    const headers = AllHeaders.decode(payload)
    if (headers === undefined) {
      return undefined
    }
    return {
      headers,
      sql: Ucs2.decode(payload.subarray(headers.length))
    }
  }

/** @returns SQL batch message payload (client-side; used in tests). */
export const encode =
  (sql: string, transactionDescriptor = 0n): Uint8Array =>
    Encode.concat(AllHeaders.encode(transactionDescriptor), Ucs2.encode(sql))
