import { Cursor, Encode, Result } from '@mssqlite/bytes'
import * as Packet from './packet.ts'

/** Complete client message reassembled from one or more packets. */
export type Message = {
  readonly type: number,
  readonly payload: Uint8Array
}

export type t =
  Message

/** One complete packet payload from a message selected for streaming. */
export type Fragment = {
  readonly type: number,
  readonly payload: Uint8Array,
  readonly eom: boolean,
  readonly ignore: boolean
}

/** Incremental packet reassembly state. */
export type State = {
  /** Raw bytes received but not yet consumed as complete packets. */
  readonly pending: Uint8Array,
  /** Payloads of packets of the in-progress message (EOM not seen yet). */
  readonly payloads: readonly Uint8Array[],
  /** Type of the in-progress message. */
  readonly type: number | undefined,
  /** `true` when a packet of the in-progress message set the IGNORE status. */
  readonly ignore: boolean
}

/** Empty reassembly state. */
export const initial: State = {
  pending: new Uint8Array(0),
  payloads: [],
  type: undefined,
  ignore: false
}

/**
 * @returns next state and any complete messages after consuming a `chunk` of
 * raw stream bytes. Packets are reassembled across chunk boundaries and
 * messages across packet boundaries (EOM terminates a message).
 */
export const push =
  (
    state: State,
    chunk: Uint8Array,
    streamedTypes: readonly number[] = []
  ): { state: State, messages: Message[], fragments: Fragment[] } => {
    let pending = state.pending.byteLength === 0 ?
      chunk :
      Encode.concat(state.pending, chunk)
    let payloads = [ ...state.payloads ]
    let type = state.type
    let ignore = state.ignore
    const messages: Message[] = []
    const fragments: Fragment[] = []
    for (;;) {
      if (pending.byteLength < Packet.headerLength) {
        break
      }
      const header = Packet.decodeHeader(Cursor.of(pending))
      if (Result.failed(header)) {
        break
      }
      const { length, status } = header.value
      // A packet must at least cover its own header; a shorter length would
      // never advance `pending` and spin forever. Malformed framing is
      // unrecoverable — signal it so the caller drops the connection.
      if (length < Packet.headerLength) {
        throw new Error(`Malformed TDS packet: length ${length} is smaller than the header.`)
      }
      if (pending.byteLength < length) {
        break
      }
      if (type !== undefined && type !== header.value.type) {
        throw new Error('Malformed TDS message: packet type changed before EOM.')
      }
      type ??= header.value.type
      if ((status & Packet.Status.ignore) !== 0) {
        ignore = true
      }
      const payload = pending.subarray(Packet.headerLength, length)
      const streamed = streamedTypes.includes(type)
      if (streamed) {
        fragments.push({
          type,
          payload,
          eom: (status & Packet.Status.eom) !== 0,
          ignore
        })
      } else {
        payloads.push(payload)
      }
      pending = pending.subarray(length)
      if ((status & Packet.Status.eom) !== 0) {
        // A message flagged IGNORE (client canceled mid-send) must be
        // discarded, not executed; the client follows with an Attention.
        if (!ignore && !streamed) {
          messages.push({ type, payload: Encode.concat(...payloads) })
        }
        payloads = []
        type = undefined
        ignore = false
      }
    }
    return {
      state: { pending, payloads, type, ignore },
      messages,
      fragments
    }
  }
