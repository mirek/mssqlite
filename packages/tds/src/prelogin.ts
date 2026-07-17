import { Cursor, Decode, Encode, Result } from '@mssqlite/bytes'

/** PreLogin option tokens. */
export const Option = {
  version: 0x00,
  encryption: 0x01,
  instance: 0x02,
  threadId: 0x03,
  mars: 0x04,
  traceId: 0x05,
  fedAuthRequired: 0x06,
  nonce: 0x07,
  terminator: 0xff
} as const

/** Encryption negotiation values. */
export const Encryption = {
  off: 0x00,
  on: 0x01,
  notSupported: 0x02,
  required: 0x03
} as const

export type ServerEncryption =
  | 'unsupported'
  | 'optional'
  | 'required'

export type Negotiation = {
  readonly response: number,
  readonly tls: boolean
}

const negotiations: Readonly<
Record<ServerEncryption, Readonly<Partial<Record<number, Negotiation>>>>
> = {
  unsupported: {
    [Encryption.off]: { response: Encryption.notSupported, tls: false },
    [Encryption.notSupported]: { response: Encryption.notSupported, tls: false }
  },
  optional: {
    [Encryption.off]: { response: Encryption.on, tls: true },
    [Encryption.on]: { response: Encryption.on, tls: true },
    [Encryption.notSupported]: { response: Encryption.notSupported, tls: false },
    [Encryption.required]: { response: Encryption.on, tls: true }
  },
  required: {
    [Encryption.on]: { response: Encryption.required, tls: true },
    [Encryption.required]: { response: Encryption.required, tls: true }
  }
}

/** Resolves the supported full-session subset of the MS-TDS encryption matrix. */
export const negotiateEncryption =
  (client: number, server: ServerEncryption): Negotiation | undefined =>
    negotiations[server][client]

/** Decoded PreLogin message. */
export type Prelogin = {
  readonly version?: { major: number, minor: number, build: number, subBuild: number },
  readonly encryption?: number,
  readonly instance?: string,
  readonly threadId?: number,
  readonly mars?: boolean,
  readonly fedAuthRequired?: boolean,
  /** All raw options in order of appearance. */
  readonly options: readonly { token: number, data: Uint8Array }[]
}

export type t =
  Prelogin

/** @returns decoded PreLogin message from a full message payload. */
export const decode =
  (payload: Uint8Array): Prelogin | undefined => {
    const options: { token: number, data: Uint8Array }[] = []
    let cursor = Cursor.of(payload)
    for (;;) {
      const token = Decode.uint8(cursor)
      if (Result.failed(token)) {
        return undefined
      }
      cursor = token.cursor
      if (token.value === Option.terminator) {
        break
      }
      const position = Decode.seq(Decode.uint16be, Decode.uint16be)(cursor)
      if (Result.failed(position)) {
        return undefined
      }
      const [ offset, length ] = position.value
      options.push({ token: token.value, data: payload.subarray(offset, offset + length) })
      cursor = position.cursor
    }
    const prelogin: {
      -readonly [K in keyof Prelogin]: Prelogin[K]
    } = { options }
    for (const { token, data } of options) {
      const view = Cursor.of(data)
      switch (token) {
        case Option.version: {
          const version = Decode.seq(Decode.uint8, Decode.uint8, Decode.uint16be, Decode.uint16)(view)
          if (!Result.failed(version)) {
            const [ major, minor, build, subBuild ] = version.value
            prelogin.version = { major, minor, build, subBuild }
          }
          break
        }
        case Option.encryption:
          prelogin.encryption = data[0] ?? Encryption.off
          break
        case Option.instance:
          prelogin.instance = new TextDecoder('latin1').decode(data).replace(/\0+$/, '')
          break
        case Option.threadId: {
          const threadId = Decode.uint32(view)
          if (!Result.failed(threadId)) {
            prelogin.threadId = threadId.value
          }
          break
        }
        case Option.mars:
          prelogin.mars = data[0] === 1
          break
        case Option.fedAuthRequired:
          prelogin.fedAuthRequired = data[0] === 1
          break
        default:
          break
      }
    }
    return prelogin
  }

/** Server PreLogin response fields. */
export type Response = {
  readonly version: { major: number, minor: number, build: number, subBuild?: number },
  readonly encryption: number,
  readonly instance?: string,
  readonly mars?: boolean,
  readonly fedAuthRequired?: boolean
}

/** @returns PreLogin response message payload — option headers, terminator, then option data. */
export const encode =
  (response: Response): Uint8Array => {
    const datas: { token: number, data: Uint8Array }[] = [
      {
        token: Option.version,
        data: Encode.concat(
          Encode.uint8(response.version.major),
          Encode.uint8(response.version.minor),
          Encode.uint16be(response.version.build),
          Encode.uint16(response.version.subBuild ?? 0)
        )
      },
      { token: Option.encryption, data: Encode.uint8(response.encryption) }
    ]
    if (response.instance !== undefined) {
      datas.push({
        token: Option.instance,
        data: Encode.concat(new TextEncoder().encode(response.instance), Encode.uint8(0))
      })
    }
    if (response.mars !== undefined) {
      datas.push({ token: Option.mars, data: Encode.uint8(response.mars ? 1 : 0) })
    }
    if (response.fedAuthRequired !== undefined) {
      datas.push({ token: Option.fedAuthRequired, data: Encode.uint8(response.fedAuthRequired ? 1 : 0) })
    }
    const headersLength = (datas.length * 5) + 1
    let offset = headersLength
    const headers: Uint8Array[] = []
    const payloads: Uint8Array[] = []
    for (const { token, data } of datas) {
      headers.push(Encode.concat(
        Encode.uint8(token),
        Encode.uint16be(offset),
        Encode.uint16be(data.byteLength)
      ))
      payloads.push(data)
      offset += data.byteLength
    }
    return Encode.concat(...headers, Encode.uint8(Option.terminator), ...payloads)
  }
