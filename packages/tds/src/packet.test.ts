import { expect, test } from 'vitest'
import { Cursor, Encode, Hex, Result } from '@mssqlite/bytes'
import * as Message from './message.ts'
import * as Packet from './packet.ts'

test('header decode matches MS-TDS prelogin example', () => {
  const result = Packet.decodeHeader(Cursor.of(Hex.of('12 01 00 2F 00 00 01 00')))
  expect(Result.failed(result)).toBe(false)
  expect(result.value).toEqual({
    type: Packet.Type.prelogin,
    status: Packet.Status.eom,
    length: 47,
    spid: 0,
    packetId: 1,
    window: 0
  })
})

test('header encode round trips', () => {
  const header: Packet.t = {
    type: Packet.Type.tabularResult,
    status: Packet.Status.eom,
    length: 353,
    spid: 0x014a,
    packetId: 1,
    window: 0
  }
  const bytes = Packet.encodeHeader(header)
  expect(bytes).toEqual(Hex.of('04 01 01 61 01 4A 01 00'))
  expect(Packet.decodeHeader(Cursor.of(bytes))).toMatchObject({ value: header })
})

test('split produces single EOM packet for small payloads', () => {
  const payload = Hex.of('aa bb cc')
  const packets = Packet.split(Packet.Type.tabularResult, payload)
  expect(packets).toHaveLength(1)
  expect(packets[0]).toEqual(Hex.of('04 01 00 0b 00 00 01 00 aa bb cc'))
})

test('split produces empty payload packet', () => {
  const packets = Packet.split(Packet.Type.tabularResult, new Uint8Array(0))
  expect(packets).toHaveLength(1)
  expect(packets[0]).toEqual(Hex.of('04 01 00 08 00 00 01 00'))
})

test('split chunks at packet size with EOM only on last', () => {
  const payload = new Uint8Array(10000).fill(0x55)
  const packets = Packet.split(Packet.Type.tabularResult, payload, 4096)
  expect(packets).toHaveLength(3)
  expect(packets[0]?.byteLength).toBe(4096)
  expect(packets[1]?.byteLength).toBe(4096)
  expect(packets[2]?.byteLength).toBe(8 + (10000 - (2 * 4088)))
  expect(packets[0]?.[1]).toBe(Packet.Status.normal)
  expect(packets[1]?.[1]).toBe(Packet.Status.normal)
  expect(packets[2]?.[1]).toBe(Packet.Status.eom)
})

test('message reassembly across chunk and packet boundaries', () => {
  const payload = new Uint8Array(9000).map((_, index) => index % 251)
  const stream = Encode.concat(...Packet.split(Packet.Type.sqlBatch, payload, 512))
  let state = Message.initial
  const messages: Message.t[] = []
  for (let offset = 0; offset < stream.byteLength; offset += 777) {
    const result = Message.push(state, stream.subarray(offset, offset + 777))
    state = result.state
    messages.push(...result.messages)
  }
  expect(messages).toHaveLength(1)
  expect(messages[0]?.type).toBe(Packet.Type.sqlBatch)
  expect(messages[0]?.payload).toEqual(payload)
})

test('message reassembly of two messages in one chunk', () => {
  const first = Packet.split(Packet.Type.sqlBatch, Hex.of('01 02'))
  const second = Packet.split(Packet.Type.attention, new Uint8Array(0))
  const { messages } = Message.push(Message.initial, Encode.concat(...first, ...second))
  expect(messages).toHaveLength(2)
  expect(messages[0]).toMatchObject({ type: Packet.Type.sqlBatch })
  expect(messages[1]).toMatchObject({ type: Packet.Type.attention, payload: new Uint8Array(0) })
})

test('selected message types stream packet fragments without retaining payloads', () => {
  const payload = new Uint8Array(9000).map((_, index) => index % 251)
  const packets = Packet.split(Packet.Type.bulkLoad, payload, 512)
  let state = Message.initial
  const fragments: Message.Fragment[] = []
  for (const packet of packets) {
    const result = Message.push(state, packet, [ Packet.Type.bulkLoad ])
    state = result.state
    fragments.push(...result.fragments)
    expect(result.messages).toEqual([])
    expect(state.payloads).toEqual([])
  }
  expect(Encode.concat(...fragments.map(fragment => fragment.payload))).toEqual(payload)
  expect(fragments.at(-1)?.eom).toBe(true)
  expect(state).toEqual(Message.initial)
})
