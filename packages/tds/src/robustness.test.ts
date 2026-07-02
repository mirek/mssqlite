import { expect, test } from 'vitest'
import { Cursor, Hex } from '@mssqlite/bytes'
import * as AllHeaders from './all-headers.ts'
import * as Login7 from './login7.ts'
import * as Message from './message.ts'
import * as Packet from './packet.ts'
import * as Prelogin from './prelogin.ts'
import * as Rpc from './rpc.ts'
import * as TransactionManager from './transaction-manager.ts'
import * as TypeInfo from './type-info.ts'
import * as Value from './value.ts'

const withTimeout =
  <T>(fn: () => T): T => {
    // The decoders under test are synchronous and must terminate; if one loops,
    // the test process itself would hang, which vitest surfaces as a timeout.
    return fn()
  }

test('zero-length packet header does not loop, signals malformed', () => {
  expect(() =>
    Message.push(Message.initial, Hex.of('10 01 00 00 00 00 00 00'))
  ).toThrow(/[Mm]alformed/)
})

test('zero-length inner ALL_HEADERS header does not loop', () => {
  const result = withTimeout(() =>
    AllHeaders.decode(Hex.of('64 00 00 00 00 00 00 00 02 00')))
  expect(result).toBeUndefined()
})

test('rpc and sql batch with zero inner header terminate', () => {
  expect(Rpc.decode(Hex.of('64 00 00 00 00 00 00 00 02 00'))).toBeUndefined()
  expect(TransactionManager.decode(Hex.of('64 00 00 00 00 00 00 00 02 00'))).toBeUndefined()
})

test('value decode returns failure rather than throwing on short fixed reader', () => {
  // intN with a length prefix of 3 but int64 needs 8 — must fail, not throw.
  const result = Value.decode(TypeInfo.intN(4))(Cursor.of(Hex.of('03 aa bb cc')))
  expect(result.reason).toBeDefined()
})

test('value decode of sql_variant fails cleanly', () => {
  const result = Value.decode({ type: 0x62 })(Cursor.of(Hex.of('04 00 00 00 01 02 03 04')))
  expect(result.reason).toBeDefined()
})

test('random and truncated bytes never throw or hang the decoders', () => {
  // Deterministic pseudo-random sweep (no Math.random — reproducible).
  let seed = 0x12345678
  const next = (): number => {
    seed = ((seed * 1103515245) + 12345) & 0x7fffffff
    return seed & 0xff
  }
  for (let i = 0; i < 4000; i++) {
    const length = i % 137
    const bytes = new Uint8Array(length)
    for (let j = 0; j < length; j++) {
      bytes[j] = next()
    }
    expect(() => Login7.decode(bytes)).not.toThrow()
    expect(() => Prelogin.decode(bytes)).not.toThrow()
    expect(() => Rpc.decode(bytes)).not.toThrow()
    expect(() => AllHeaders.decode(bytes)).not.toThrow()
    expect(() => TransactionManager.decode(bytes)).not.toThrow()
    // Message.push may throw only the malformed-length signal, never hang.
    try {
      Message.push(Message.initial, bytes)
    } catch (error) {
      expect((error as Error).message).toMatch(/[Mm]alformed/)
    }
  }
})

test('oversized non-max value fails instead of wrapping the length prefix', () => {
  expect(() => Value.encode(TypeInfo.nvarchar(50), 'y'.repeat(40000)))
    .toThrow(/exceeds/)
  expect(() => Value.encode(TypeInfo.varchar(50), 'y'.repeat(70000)))
    .toThrow(/exceeds/)
  // A MAX type has no such limit.
  expect(() => Value.encode(TypeInfo.nvarchar('max'), 'y'.repeat(40000))).not.toThrow()
})

test('message push discards a message flagged IGNORE on EOM', () => {
  const first = Packet.split(Packet.Type.sqlBatch, Hex.of('01 02'))[0] ?? new Uint8Array(0)
  // Flip the status byte to EOM | IGNORE.
  const ignored = Uint8Array.from(first)
  ignored[1] = Packet.Status.eom | Packet.Status.ignore
  const { messages } = Message.push(Message.initial, ignored)
  expect(messages).toHaveLength(0)
})
