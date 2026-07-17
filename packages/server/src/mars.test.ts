import { afterAll, beforeAll, expect, test } from 'vitest'
import { Cursor, Encode, Result, Ucs2 } from '@mssqlite/bytes'
import { Login7, Packet, Prelogin, Smp, SqlBatch, Token } from '@mssqlite/tds'
import { connect, type Socket } from 'node:net'
import { listen, type Listening } from './server.ts'

type Wire = {
  readonly socket: Socket,
  readonly read: (length: number) => Promise<Uint8Array>
}

type ClientSession = {
  readonly id: number,
  sequence: number,
  window: number
}

let listening: Listening
let wire: Wire

const wireOf =
  (socket: Socket): Wire => {
    let pending = Buffer.alloc(0)
    let wake: (() => void) | undefined
    let failure: Error | undefined
    socket.on('data', chunk => {
      pending = Buffer.concat([ pending, chunk ])
      wake?.()
      wake = undefined
    })
    const fail = (error: Error): void => {
      failure = error
      wake?.()
      wake = undefined
    }
    socket.once('error', fail)
    socket.once('close', () => fail(new Error('Socket closed before the expected bytes arrived.')))
    const wait = (): Promise<void> => new Promise(resolve => {
      wake = resolve
    })
    const read = async (length: number): Promise<Uint8Array> => {
      while (pending.byteLength < length) {
        if (failure !== undefined) {
          throw failure
        }
        await wait()
      }
      const value = Uint8Array.from(pending.subarray(0, length))
      pending = pending.subarray(length)
      return value
    }
    return { socket, read }
  }

const openWire =
  (port: number): Promise<Wire> =>
    new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => resolve(wireOf(socket)))
      socket.once('error', reject)
    })

const tdsMessage =
  async (wire_: Wire): Promise<{ readonly type: number, readonly payload: Uint8Array }> => {
    const payloads: Uint8Array[] = []
    let type = -1
    for (;;) {
      const headerBytes = await wire_.read(Packet.headerLength)
      const header = Packet.decodeHeader(Cursor.of(headerBytes))
      if (Result.failed(header)) {
        throw new Error(header.reason)
      }
      type = header.value.type
      payloads.push(await wire_.read(header.value.length - Packet.headerLength))
      if ((header.value.status & Packet.Status.eom) !== 0) {
        return { type, payload: Encode.concat(...payloads) }
      }
    }
  }

const smpPacket =
  async (wire_: Wire): Promise<Smp.Packet> => {
    const headerBytes = await wire_.read(Smp.headerLength)
    const header = Smp.decodeHeader(Cursor.of(headerBytes))
    if (Result.failed(header)) {
      throw new Error(header.reason)
    }
    return {
      ...header.value,
      data: await wire_.read(header.value.length - Smp.headerLength)
    }
  }

const loginPayload =
  (): Uint8Array => {
    const fields = [
      { data: Ucs2.encode('mars-test'), count: 9 },
      { data: Ucs2.encode('sa'), count: 2 },
      { data: Login7.scramblePassword('secret'), count: 6 },
      { data: Ucs2.encode('mssqlite-tests'), count: 14 },
      { data: new Uint8Array(0), count: 0 },
      { data: new Uint8Array(0), count: 0 },
      { data: Ucs2.encode('tds'), count: 3 },
      { data: new Uint8Array(0), count: 0 },
      { data: Ucs2.encode('master'), count: 6 }
    ]
    const fixedLength = 94
    let offset = fixedLength
    const pairs: Uint8Array[] = []
    for (const field of fields) {
      pairs.push(Encode.uint16(offset), Encode.uint16(field.count))
      offset += field.data.byteLength
    }
    return Encode.concat(
      Encode.uint32(offset),
      Encode.uint32(0x04000074),
      Encode.uint32(4096),
      Encode.uint32(1),
      Encode.uint32(123),
      Encode.uint32(0),
      Encode.uint8(0xe0), Encode.uint8(0x03), Encode.uint8(0), Encode.uint8(0),
      Encode.int32(0), Encode.uint32(0x0409),
      ...pairs,
      new Uint8Array(6),
      Encode.uint16(0), Encode.uint16(0),
      Encode.uint16(0), Encode.uint16(0),
      Encode.uint16(0), Encode.uint16(0),
      Encode.uint32(0),
      ...fields.map(field => field.data)
    )
  }

const writePackets =
  (wire_: Wire, packets: readonly Uint8Array[]): void => {
    for (const packet of packets) {
      wire_.socket.write(packet)
    }
  }

const openSession =
  (wire_: Wire, id: number, window = 100): ClientSession => {
    wire_.socket.write(Smp.encode(Smp.Type.syn, id, 0, window))
    return { id, sequence: 0, window }
  }

const sendTds =
  (wire_: Wire, session: ClientSession, type: number, payload: Uint8Array): void => {
    for (const packet of Packet.split(type, payload, 4096)) {
      session.sequence += 1
      wire_.socket.write(Smp.encode(
        Smp.Type.data, session.id, session.sequence, session.window, packet))
    }
  }

const sendSql =
  (wire_: Wire, session: ClientSession, sql: string): void =>
    sendTds(wire_, session, Packet.Type.sqlBatch, SqlBatch.encode(sql))

const response =
  async (wire_: Wire, sessionId: number): Promise<Uint8Array> => {
    const payloads: Uint8Array[] = []
    for (;;) {
      const outer = await smpPacket(wire_)
      if (outer.type !== Smp.Type.data) {
        continue
      }
      expect(outer.sessionId).toBe(sessionId)
      const inner = Packet.decodeHeader(Cursor.of(outer.data))
      if (Result.failed(inner)) {
        throw new Error(inner.reason)
      }
      expect(inner.value.length).toBe(outer.data.byteLength)
      payloads.push(outer.data.subarray(Packet.headerLength))
      if ((inner.value.status & Packet.Status.eom) !== 0) {
        return Encode.concat(...payloads)
      }
    }
  }

const includes =
  (bytes: Uint8Array, sequence: readonly number[]): boolean => {
    for (let offset = 0; offset <= bytes.byteLength - sequence.length; offset++) {
      if (sequence.every((value, index) => bytes[offset + index] === value)) {
        return true
      }
    }
    return false
  }

const closeSession =
  async (wire_: Wire, session: ClientSession): Promise<void> => {
    wire_.socket.write(Smp.encode(
      Smp.Type.fin, session.id, session.sequence, session.window))
    for (;;) {
      const packet = await smpPacket(wire_)
      if (packet.type === Smp.Type.fin && packet.sessionId === session.id) {
        return
      }
    }
  }

beforeAll(async () => {
  listening = await listen({
    path: ':memory:', port: 0, databaseName: 'master', authentication: { type: 'insecure' }
  })
  wire = await openWire(listening.port)

  const prelogin = Prelogin.encode({
    version: { major: 16, minor: 0, build: 1000 },
    encryption: Prelogin.Encryption.notSupported,
    mars: true
  })
  writePackets(wire, Packet.split(Packet.Type.prelogin, prelogin))
  const negotiated = await tdsMessage(wire)
  expect(negotiated.type).toBe(Packet.Type.tabularResult)
  expect(Prelogin.decode(negotiated.payload)?.mars).toBe(true)

  writePackets(wire, Packet.split(Packet.Type.login7, loginPayload()))
  const login = await tdsMessage(wire)
  expect(login.type).toBe(Packet.Type.tabularResult)
  expect(login.payload).toContain(Token.Token.loginAck)
}, 20000)

afterAll(async () => {
  wire.socket.destroy()
  await listening.close()
})

test('MARS multiplexes readers, writes, errors, transactions, attention and teardown', async () => {
  const reader = openSession(wire, 0, 4)
  sendSql(wire, reader, 'SELECT 1 AS value FROM GENERATE_SERIES(1, 5000)')

  for (let sequence = 1; sequence <= 4; sequence++) {
    const packet = await smpPacket(wire)
    expect(packet).toMatchObject({
      type: Smp.Type.data,
      sessionId: reader.id,
      sequence
    })
  }

  const sibling = openSession(wire, 1)
  sendSql(wire, sibling, 'SELECT 42 AS answer')
  const siblingResult = await response(wire, sibling.id)
  expect(siblingResult).toContain(42)
  expect(siblingResult).not.toContain(Token.Token.error)

  reader.window = 100
  wire.socket.write(Smp.encode(
    Smp.Type.ack, reader.id, reader.sequence, reader.window))
  const readerTail = await response(wire, reader.id)
  expect(readerTail.at(-13)).toBe(Token.Token.done)

  sendSql(wire, sibling, 'CREATE TABLE mars_tx (id INT PRIMARY KEY)')
  expect(await response(wire, sibling.id)).not.toContain(Token.Token.error)
  sendSql(wire, sibling, 'BEGIN TRANSACTION')
  await response(wire, sibling.id)

  const writer = openSession(wire, 2)
  sendSql(wire, writer, 'INSERT INTO mars_tx VALUES (1)')
  expect(await response(wire, writer.id)).not.toContain(Token.Token.error)
  sendSql(wire, sibling, 'ROLLBACK TRANSACTION')
  await response(wire, sibling.id)
  sendSql(wire, writer, 'INSERT INTO mars_tx VALUES (1)')
  expect(await response(wire, writer.id)).not.toContain(Token.Token.error)

  sendSql(wire, writer, 'SELECT * FROM mars_missing')
  expect(await response(wire, writer.id)).toContain(Token.Token.error)
  sendSql(wire, sibling, 'SELECT 7 AS still_alive')
  expect(await response(wire, sibling.id)).not.toContain(Token.Token.error)

  const canceled = openSession(wire, 3, 4)
  sendSql(wire, canceled, 'SELECT 1 AS value FROM GENERATE_SERIES(1, 5000)')
  for (let sequence = 1; sequence <= 4; sequence++) {
    expect(await smpPacket(wire)).toMatchObject({ sessionId: canceled.id, sequence })
  }
  canceled.window = 100
  sendTds(wire, canceled, Packet.Type.attention, new Uint8Array(0))
  const attention = await response(wire, canceled.id)
  expect(includes(attention, [ Token.Token.done, Token.Status.attention, 0 ])).toBe(true)
  sendSql(wire, sibling, 'SELECT 8 AS after_cancel')
  expect(await response(wire, sibling.id)).not.toContain(Token.Token.error)

  await closeSession(wire, canceled)
  await closeSession(wire, writer)
  await closeSession(wire, sibling)
  await closeSession(wire, reader)
}, 20000)
