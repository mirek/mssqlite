import { Cursor, Decode, Encode, Result } from '@mssqlite/bytes'

/** SMP packet header size in bytes. */
export const headerLength = 16

/** Session Multiplex Protocol signature (`S`). */
export const signature = 0x53

/** SMP control flags. Flags are mutually exclusive. */
export const Type = {
  syn: 0x01,
  ack: 0x02,
  fin: 0x04,
  data: 0x08
} as const

export type Type =
  typeof Type[keyof typeof Type]

export type Header = {
  readonly type: number,
  readonly sessionId: number,
  readonly length: number,
  readonly sequence: number,
  readonly window: number
}

export type Packet = Header & {
  readonly data: Uint8Array
}

export type State = {
  readonly pending: Uint8Array
}

export const initial: State = {
  pending: new Uint8Array(0)
}

const types: readonly number[] = [ Type.syn, Type.ack, Type.fin, Type.data ]
const maximumLength = 0xffff + headerLength

/** Decodes one 16-byte SMP header. All multi-byte fields are little-endian. */
export const decodeHeader =
  (cursor: Cursor.t): Result.t<Header> => {
    const decoded = Decode.seq(
      Decode.uint8, Decode.uint8, Decode.uint16, Decode.uint32, Decode.uint32, Decode.uint32
    )(cursor)
    if (Result.failed(decoded)) {
      return decoded
    }
    const [ smid, type, sessionId, length, sequence, window ] = decoded.value
    if (smid !== signature) {
      return Result.fail(cursor, `Invalid SMP signature 0x${smid.toString(16)}.`)
    }
    if (!types.includes(type)) {
      return Result.fail(cursor, `Invalid SMP control flag 0x${type.toString(16)}.`)
    }
    if (length < headerLength || length > maximumLength) {
      return Result.fail(cursor, `Invalid SMP packet length ${length}.`)
    }
    if (type !== Type.data && length !== headerLength) {
      return Result.fail(cursor, 'SMP control packets cannot carry data.')
    }
    if (type === Type.data && length < headerLength + 8) {
      return Result.fail(cursor, 'SMP DATA must contain a complete TDS packet header.')
    }
    return Result.ok(decoded.cursor, { type, sessionId, length, sequence, window })
  }

/** Encodes an SMP packet. */
export const encode =
  (
    type: Type,
    sessionId: number,
    sequence: number,
    window: number,
    data: Uint8Array = new Uint8Array(0)
  ): Uint8Array => {
    if (!types.includes(type)) {
      throw new RangeError(`Invalid SMP control flag 0x${type.toString(16)}.`)
    }
    if (type !== Type.data && data.byteLength > 0) {
      throw new RangeError('SMP control packets cannot carry data.')
    }
    if (type === Type.data && data.byteLength < 8) {
      throw new RangeError('SMP DATA must contain a complete TDS packet header.')
    }
    if (data.byteLength + headerLength > maximumLength) {
      throw new RangeError('SMP packet data is too large.')
    }
    return Encode.concat(
      Encode.uint8(signature),
      Encode.uint8(type),
      Encode.uint16(sessionId),
      Encode.uint32(headerLength + data.byteLength),
      Encode.uint32(sequence),
      Encode.uint32(window),
      data
    )
  }

/**
 * Incrementally splits an SMP byte stream into complete packets. Framing
 * errors are fatal because there is no safe next signature on a byte stream.
 */
export const push =
  (state: State, chunk: Uint8Array): { readonly state: State, readonly packets: readonly Packet[] } => {
    let pending = state.pending.byteLength === 0 ? chunk : Encode.concat(state.pending, chunk)
    const packets: Packet[] = []
    for (;;) {
      if (pending.byteLength < headerLength) {
        break
      }
      const header = decodeHeader(Cursor.of(pending))
      if (Result.failed(header)) {
        throw new Error(header.reason)
      }
      if (pending.byteLength < header.value.length) {
        break
      }
      const data = Uint8Array.from(pending.subarray(headerLength, header.value.length))
      packets.push({ ...header.value, data })
      pending = pending.subarray(header.value.length)
    }
    return {
      state: { pending: Uint8Array.from(pending) },
      packets
    }
  }
