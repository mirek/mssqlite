import { Cursor, Decode, Encode, Result } from '@mssqlite/bytes'

/** TDS packet header size in bytes. */
export const headerLength = 8

/** Default packet size (including header) until negotiated otherwise. */
export const defaultPacketSize = 4096

/** Packet types. */
export const Type = {
  sqlBatch: 0x01,
  preTds7Login: 0x02,
  rpc: 0x03,
  tabularResult: 0x04,
  attention: 0x06,
  bulkLoad: 0x07,
  federatedAuthToken: 0x08,
  transactionManager: 0x0e,
  login7: 0x10,
  sspi: 0x11,
  prelogin: 0x12
} as const

export type Type =
  typeof Type[keyof typeof Type]

/** Status flags. */
export const Status = {
  normal: 0x00,
  eom: 0x01,
  ignore: 0x02,
  resetConnection: 0x04,
  resetConnectionSkipTran: 0x08
} as const

/** TDS packet header. */
export type Header = {
  readonly type: number,
  readonly status: number,
  readonly length: number,
  readonly spid: number,
  readonly packetId: number,
  readonly window: number
}

export type t =
  Header

/** @returns 8 header bytes — length and spid are big-endian, everything else single bytes. */
export const encodeHeader =
  (header: Header): Uint8Array =>
    Encode.concat(
      Encode.uint8(header.type),
      Encode.uint8(header.status),
      Encode.uint16be(header.length),
      Encode.uint16be(header.spid),
      Encode.uint8(header.packetId),
      Encode.uint8(header.window)
    )

/** Packet header decoder. */
export const decodeHeader: (cursor: Cursor.t) => Result.t<Header> =
  Decode.map(
    Decode.seq(Decode.uint8, Decode.uint8, Decode.uint16be, Decode.uint16be, Decode.uint8, Decode.uint8),
    ([ type, status, length, spid, packetId, window ]) =>
      ({ type, status, length, spid, packetId, window })
  )

/**
 * @returns complete packets for a message `payload` of given `type`, splitting at
 * `packetSize` (total packet bytes including the 8-byte header). Only the last
 * packet has the EOM status bit set.
 */
export const split =
  (type: number, payload: Uint8Array, packetSize = defaultPacketSize, spid = 0): Uint8Array[] => {
    const capacity = packetSize - headerLength
    const packets: Uint8Array[] = []
    let offset = 0
    let packetId = 1
    do {
      const chunk = payload.subarray(offset, offset + capacity)
      offset += chunk.byteLength
      const last = offset >= payload.byteLength
      const header: Header = {
        type,
        status: last ? Status.eom : Status.normal,
        length: headerLength + chunk.byteLength,
        spid,
        packetId: packetId++ % 0x100,
        window: 0
      }
      packets.push(Encode.concat(encodeHeader(header), chunk))
    } while (offset < payload.byteLength)
    return packets
  }
