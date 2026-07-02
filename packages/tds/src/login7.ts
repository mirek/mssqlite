import { Cursor, Decode, Result, Ucs2 } from '@mssqlite/bytes'

/** Decoded Login7 message. */
export type Login7 = {
  readonly tdsVersion: number,
  readonly packetSize: number,
  readonly clientProgVer: number,
  readonly clientPid: number,
  readonly connectionId: number,
  readonly optionFlags1: number,
  readonly optionFlags2: number,
  readonly typeFlags: number,
  readonly optionFlags3: number,
  readonly clientTimeZone: number,
  readonly clientLcid: number,
  readonly hostName: string,
  readonly userName: string,
  readonly password: string,
  readonly appName: string,
  readonly serverName: string,
  readonly clientInterfaceName: string,
  readonly language: string,
  readonly database: string,
  readonly features: readonly { id: number, data: Uint8Array }[]
}

export type t =
  Login7

/** @returns descrambled password byte. */
const descrambleByte =
  (byte: number): number => {
    const unxored = byte ^ 0xa5
    return ((unxored >> 4) | ((unxored << 4) & 0xff)) & 0xff
  }

/** @returns descrambled password string from scrambled UCS-2 bytes. */
export const descramblePassword =
  (bytes: Uint8Array): string =>
    Ucs2.decode(Uint8Array.from(bytes, descrambleByte))

/** @returns scrambled password bytes from a password string (client-side; used in tests). */
export const scramblePassword =
  (password: string): Uint8Array =>
    Uint8Array.from(Ucs2.encode(password), byte =>
      (((byte << 4) & 0xff) | (byte >> 4)) ^ 0xa5)

const fExtension = 0x10

const decodeFeatures =
  (payload: Uint8Array, extensionOffset: number): { id: number, data: Uint8Array }[] => {
    const pointer = Decode.uint32(Cursor.of(payload, extensionOffset))
    if (Result.failed(pointer)) {
      return []
    }
    const features: { id: number, data: Uint8Array }[] = []
    let cursor = Cursor.of(payload, pointer.value)
    for (;;) {
      const id = Decode.uint8(cursor)
      if (Result.failed(id) || id.value === 0xff) {
        break
      }
      const data = Decode.lVarbyte(id.cursor)
      if (Result.failed(data)) {
        break
      }
      features.push({ id: id.value, data: data.value })
      cursor = data.cursor
    }
    return features
  }

/** @returns decoded Login7 from a full message payload, `undefined` on malformed input. */
export const decode =
  (payload: Uint8Array): Login7 | undefined => {
    const fixed = Decode.seq(
      Decode.uint32, // length
      Decode.uint32, // tdsVersion
      Decode.uint32, // packetSize
      Decode.uint32, // clientProgVer
      Decode.uint32, // clientPid
      Decode.uint32, // connectionId
      Decode.uint8, // optionFlags1
      Decode.uint8, // optionFlags2
      Decode.uint8, // typeFlags
      Decode.uint8, // optionFlags3
      Decode.int32, // clientTimeZone
      Decode.uint32 // clientLcid
    )(Cursor.of(payload))
    if (Result.failed(fixed)) {
      return undefined
    }
    const [
      length, tdsVersion, packetSize, clientProgVer, clientPid, connectionId,
      optionFlags1, optionFlags2, typeFlags, optionFlags3, clientTimeZone, clientLcid
    ] = fixed.value
    if (length > payload.byteLength) {
      return undefined
    }
    const pair = (index: number): { offset: number, count: number } | undefined => {
      const result = Decode.seq(Decode.uint16, Decode.uint16)(Cursor.of(payload, 36 + (index * 4)))
      return Result.failed(result) ?
        undefined :
        { offset: result.value[0], count: result.value[1] }
    }
    const chars = (index: number): string => {
      const at = pair(index)
      return at === undefined ?
        '' :
        Ucs2.decode(payload.subarray(at.offset, at.offset + (at.count * 2)))
    }
    const passwordAt = pair(2)
    const extensionAt = pair(5)
    return {
      tdsVersion,
      packetSize,
      clientProgVer,
      clientPid,
      connectionId,
      optionFlags1,
      optionFlags2,
      typeFlags,
      optionFlags3,
      clientTimeZone,
      clientLcid,
      hostName: chars(0),
      userName: chars(1),
      password: passwordAt === undefined ?
        '' :
        descramblePassword(payload.subarray(passwordAt.offset, passwordAt.offset + (passwordAt.count * 2))),
      appName: chars(3),
      serverName: chars(4),
      clientInterfaceName: chars(6),
      language: chars(7),
      database: chars(8),
      features: (optionFlags3 & fExtension) !== 0 && extensionAt !== undefined ?
        decodeFeatures(payload, extensionAt.offset) :
        []
    }
  }
