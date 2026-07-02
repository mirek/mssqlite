import { Cursor, Decode, Encode, Result } from '@mssqlite/bytes'

/** Header types within ALL_HEADERS. */
export const Type = {
  queryNotifications: 0x0001,
  transactionDescriptor: 0x0002,
  traceActivity: 0x0003
} as const

/** Decoded ALL_HEADERS prefix of a client request. */
export type AllHeaders = {
  /** Total ALL_HEADERS length in bytes — payload continues at this offset. */
  readonly length: number,
  /** Transaction descriptor from the type 0x0002 header, 0n in autocommit. */
  readonly transactionDescriptor: bigint,
  readonly outstandingRequestCount: number
}

export type t =
  AllHeaders

/** @returns decoded ALL_HEADERS from the start of a message payload. */
export const decode =
  (payload: Uint8Array): AllHeaders | undefined => {
    const total = Decode.uint32(Cursor.of(payload))
    if (Result.failed(total)) {
      return undefined
    }
    let transactionDescriptor = 0n
    let outstandingRequestCount = 1
    let cursor = total.cursor
    while (cursor.offset < total.value) {
      const header = Decode.seq(Decode.uint32, Decode.uint16)(cursor)
      if (Result.failed(header)) {
        return undefined
      }
      const [ headerLength, headerType ] = header.value
      if (headerType === Type.transactionDescriptor) {
        const data = Decode.seq(Decode.uint64, Decode.uint32)(header.cursor)
        if (!Result.failed(data)) {
          transactionDescriptor = data.value[0]
          outstandingRequestCount = data.value[1]
        }
      }
      cursor = Cursor.advanced(cursor, headerLength)
    }
    return {
      length: total.value,
      transactionDescriptor,
      outstandingRequestCount
    }
  }

/** @returns ALL_HEADERS bytes with a transaction descriptor header (client-side; used in tests). */
export const encode =
  (transactionDescriptor = 0n, outstandingRequestCount = 1): Uint8Array =>
    Encode.concat(
      Encode.uint32(22),
      Encode.uint32(18),
      Encode.uint16(Type.transactionDescriptor),
      Encode.uint64(transactionDescriptor),
      Encode.uint32(outstandingRequestCount)
    )
