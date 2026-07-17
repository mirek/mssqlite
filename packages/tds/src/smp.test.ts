import { expect, test } from 'vitest'
import { Cursor, Encode, Hex, Result } from '@mssqlite/bytes'
import * as Packet from './packet.ts'
import * as Smp from './smp.ts'

test('decodes the MC-SMP SYN header layout', () => {
  const bytes = Hex.of('53 01 05 00 10 00 00 00 00 00 00 00 04 00 00 00')
  expect(Smp.decodeHeader(Cursor.of(bytes))).toMatchObject({
    value: {
      type: Smp.Type.syn,
      sessionId: 5,
      length: 16,
      sequence: 0,
      window: 4
    }
  })
  expect(Smp.encode(Smp.Type.syn, 5, 0, 4)).toEqual(bytes)
})

test('DATA wraps exactly one complete TDS packet', () => {
  const tds = Packet.split(Packet.Type.sqlBatch, Hex.of('01 02 03'))[0] ?? new Uint8Array(0)
  const bytes = Smp.encode(Smp.Type.data, 7, 12, 19, tds)
  expect(bytes.subarray(0, 16)).toEqual(
    Hex.of('53 08 07 00 1B 00 00 00 0C 00 00 00 13 00 00 00'))
  const result = Smp.push(Smp.initial, bytes)
  expect(result.state).toEqual(Smp.initial)
  expect(result.packets).toEqual([ {
    type: Smp.Type.data,
    sessionId: 7,
    length: 27,
    sequence: 12,
    window: 19,
    data: tds
  } ])
})

test('incremental framing preserves interleaved session packet order', () => {
  const tds = Packet.split(Packet.Type.attention, new Uint8Array(0))[0] ?? new Uint8Array(0)
  const stream = Encode.concat(
    Smp.encode(Smp.Type.syn, 0, 0, 4),
    Smp.encode(Smp.Type.syn, 1, 0, 4),
    Smp.encode(Smp.Type.data, 1, 1, 4, tds),
    Smp.encode(Smp.Type.fin, 0, 0, 4)
  )
  let state = Smp.initial
  const packets: Smp.Packet[] = []
  for (let offset = 0; offset < stream.byteLength; offset += 3) {
    const decoded = Smp.push(state, stream.subarray(offset, offset + 3))
    state = decoded.state
    packets.push(...decoded.packets)
  }
  expect(state).toEqual(Smp.initial)
  expect(packets.map(packet => [ packet.type, packet.sessionId ])).toEqual([
    [ Smp.Type.syn, 0 ],
    [ Smp.Type.syn, 1 ],
    [ Smp.Type.data, 1 ],
    [ Smp.Type.fin, 0 ]
  ])
})

test('rejects malformed signatures, flags, lengths and control payloads', () => {
  const invalid = [
    '52 01 00 00 10 00 00 00 00 00 00 00 04 00 00 00',
    '53 03 00 00 10 00 00 00 00 00 00 00 04 00 00 00',
    '53 01 00 00 0F 00 00 00 00 00 00 00 04 00 00 00',
    '53 01 00 00 11 00 00 00 00 00 00 00 04 00 00 00',
    '53 08 00 00 17 00 00 00 01 00 00 00 04 00 00 00'
  ]
  for (const fixture of invalid) {
    expect(Result.failed(Smp.decodeHeader(Cursor.of(Hex.of(fixture))))).toBe(true)
  }
  expect(() => Smp.encode(Smp.Type.data, 0, 1, 4)).toThrow(/complete TDS/)
  expect(() => Smp.encode(Smp.Type.syn, 0, 0, 4, Uint8Array.of(1))).toThrow(/cannot carry/)
})

test('proper prefixes retain bounded pending input without throwing', () => {
  const tds = Packet.split(Packet.Type.sqlBatch, new Uint8Array(100).fill(0x55), 128)[0] ??
    new Uint8Array(0)
  const packet = Smp.encode(Smp.Type.data, 2, 1, 4, tds)
  for (let length = 0; length < packet.byteLength; length++) {
    const result = Smp.push(Smp.initial, packet.subarray(0, length))
    expect(result.packets).toEqual([])
    expect(result.state.pending.byteLength).toBe(length)
  }
})
